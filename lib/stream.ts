/**
 * lib/stream.ts
 *
 * ArkVibe / Monochrome Stream Resolution Module
 *
 * Implements a high-reliability audio stream resolver featuring:
 * 1. Tier 1: Primary Hi-Res Proxies (Tidal / Deezer via Monochrome) with 2.5s racing timeout.
 * 2. Tier 2: RapidAPI Fallback triggered on 5xx errors (500, 502, 503, 504, 530) or timeout.
 * 3. Strict Track Matching Verification (metadata normalization, <=3s duration delta, artist match).
 */

// ============================================================================
// 1. Types & Interfaces
// ============================================================================

export type AudioQuality =
    | 'HI_RES_LOSSLESS'
    | 'LOSSLESS'
    | 'HIGH'
    | 'NORMAL'
    | 'LOW'
    | 'DOLBY_ATMOS_EAC3_HIGH'
    | 'DOLBY_ATMOS_AC4_HIGH';

export interface ArtistInfo {
    id?: string | number;
    name: string;
}

export interface TrackMetadata {
    id: string | number;
    title: string;
    artist?: ArtistInfo | string;
    artists?: (ArtistInfo | string)[];
    album?: {
        id?: string | number;
        title?: string;
    };
    duration: number; // Duration in SECONDS
    isrc?: string;
    audioQuality?: AudioQuality | string;
    version?: string;
}

export interface StreamResult {
    url: string;
    sourceUrl?: string;
    provider: 'monochrome' | 'tidal' | 'deezer' | 'rapidapi' | string;
    quality: string;
    qualityDisplay: string;
    codec: string;
    mediaMimeType: string;
    playbackType: 'direct' | 'hls' | 'dash';
    lossless: boolean;
    tier: 1 | 2;
    latencyMs: number;
    matchedTrack?: {
        title: string;
        artist: string;
        duration: number;
        durationDiffSec: number;
        id?: string | number;
    };
}

export interface ProxyEndpoint {
    name: string;
    provider: 'tidal' | 'deezer' | 'monochrome';
    buildUrl: (track: TrackMetadata, quality: string) => string;
    quality: string;
    codec: string;
    mimeType: string;
    lossless: boolean;
}

export interface StreamResolverOptions {
    tier1TimeoutMs?: number;
    durationToleranceSec?: number;
    rapidApiKey?: string;
    rapidApiHost?: string;
    rapidApiBaseUrl?: string;
    customProxies?: ProxyEndpoint[];
}

export interface RapidApiTrackItem {
    id?: string | number;
    title?: string;
    name?: string;
    artist?: string | { name: string };
    artists?: (string | { name: string })[];
    duration?: number; // Might be in seconds or milliseconds
    duration_ms?: number;
    length?: number;
    streamUrl?: string;
    url?: string;
    audioUrl?: string;
    downloadUrl?: string;
    link?: string;
}

// ============================================================================
// 2. Configuration & Environment Variables
// ============================================================================

export function getEnvVariable(key: string, fallback = ''): string {
    // 1. Node.js process.env
    if (typeof process !== 'undefined' && process.env?.[key]) {
        return process.env[key] as string;
    }

    // 2. Vite / Modern Bundlers (import.meta.env)
    try {
        // @ts-ignore
        if (typeof import.meta !== 'undefined' && import.meta.env) {
            // @ts-ignore
            if (import.meta.env[key]) return import.meta.env[key];
            // @ts-ignore
            if (import.meta.env[`VITE_${key}`]) return import.meta.env[`VITE_${key}`];
        }
    } catch {
        // Ignore if import.meta is unavailable
    }

    return fallback;
}

export function getRapidApiConfig(options?: StreamResolverOptions) {
    const apiKey =
        options?.rapidApiKey ||
        getEnvVariable('RAPIDAPI_KEY') ||
        getEnvVariable('VITE_RAPIDAPI_KEY');

    const apiHost =
        options?.rapidApiHost ||
        getEnvVariable('RAPIDAPI_HOST') ||
        getEnvVariable('VITE_RAPIDAPI_HOST') ||
        'spotify-downloader9.p.rapidapi.com';

    const baseUrl =
        options?.rapidApiBaseUrl ||
        getEnvVariable('RAPIDAPI_BASE_URL') ||
        `https://${apiHost}`;

    return { apiKey, apiHost, baseUrl };
}

// ============================================================================
// 3. Strict Metadata Normalization & Verification Gatekeeper
// ============================================================================

/**
 * Normalizes a song title by stripping parenthetical & bracketed metadata
 * like "(Remastered)", "[Explicit]", "(2021 Remaster)", "(feat. Artist)", etc.
 */
export function normalizeSongTitle(title: string): string {
    if (!title) return '';

    return (
        title
            // Unicode decomposition to strip accents / diacritics
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            // Strip common parenthetical/bracketed remaster & audio tags
            .replace(
                /[\(\[]\s*(?:remaster(?:ed)?(?:\s*\d{2,4})?|explicit|clean|deluxe(?: edition)?|bonus(?: track)?|anniversary(?: edition)?|live|acoustic|instrumental|radio edit|original mix|mono|stereo|single version|album version|feat\.?.*|ft\.?.*)[\)\]]/gi,
                ''
            )
            // Strip any remaining trailing parenthesis containing years or generic tags
            .replace(/[\(\[]\s*\d{4}\s*(?:remaster|version)?[\)\]]/gi, '')
            // Remove special characters, keep alphanumeric and spaces
            .replace(/[^a-zA-Z0-9\s]/g, ' ')
            // Condense multiple spaces
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
    );
}

/**
 * Normalizes artist name for strict fuzzy equality checking.
 */
export function normalizeArtistName(artist: string | ArtistInfo | (string | ArtistInfo)[] | undefined): string {
    if (!artist) return '';

    let raw = '';
    if (Array.isArray(artist)) {
        raw = artist
            .map((a) => (typeof a === 'string' ? a : a?.name || ''))
            .filter(Boolean)
            .join(' ');
    } else if (typeof artist === 'object') {
        raw = artist.name || '';
    } else {
        raw = String(artist);
    }

    return raw
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/^(the|a|an)\s+/i, '') // Ignore leading "The"
        .replace(/\b(feat|featuring|ft)\.?\s+.*$/i, '') // Ignore featured secondary artists
        .replace(/[^a-zA-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/**
 * Normalizes duration to seconds.
 */
export function normalizeDurationSeconds(duration: number | undefined): number {
    if (!duration || duration <= 0) return 0;
    // If value exceeds 10,000, it is in milliseconds -> convert to seconds
    if (duration > 10000) {
        return duration / 1000;
    }
    return duration;
}

/**
 * Validates that candidate track from RapidAPI matches the requested track
 * within strict tolerances (<= 3s duration mismatch and matching artist).
 */
export function verifyTrackMatch(
    requested: TrackMetadata,
    candidate: RapidApiTrackItem,
    toleranceSec = 3.0
): { valid: boolean; reason?: string; durationDiffSec: number } {
    const requestedDuration = normalizeDurationSeconds(requested.duration);
    const candidateRawDuration =
        candidate.duration ?? candidate.duration_ms ?? candidate.length ?? 0;
    const candidateDuration = normalizeDurationSeconds(candidateRawDuration);

    const durationDiffSec = Math.abs(candidateDuration - requestedDuration);

    // 1. Duration check (only if both durations are available and > 0)
    if (requestedDuration > 0 && candidateDuration > 0) {
        if (durationDiffSec > toleranceSec) {
            return {
                valid: false,
                reason: `Duration mismatch of ${durationDiffSec.toFixed(1)}s exceeds ${toleranceSec.toFixed(1)}s tolerance (Requested: ${requestedDuration.toFixed(1)}s, Candidate: ${candidateDuration.toFixed(1)}s)`,
                durationDiffSec,
            };
        }
    }

    // 2. Artist name match
    const normReqArtist = normalizeArtistName(requested.artist || requested.artists);
    const normCandArtist = normalizeArtistName(
        candidate.artist || candidate.artists || ''
    );

    if (normReqArtist && normCandArtist) {
        const directMatch =
            normCandArtist.includes(normReqArtist) ||
            normReqArtist.includes(normCandArtist);

        if (!directMatch) {
            return {
                valid: false,
                reason: `Artist mismatch: candidate artist "${normCandArtist}" does not match requested "${normReqArtist}"`,
                durationDiffSec,
            };
        }
    }

    // 3. Title sanity check
    const normReqTitle = normalizeSongTitle(requested.title);
    const normCandTitle = normalizeSongTitle(candidate.title || candidate.name || '');

    if (normReqTitle && normCandTitle) {
        const titleMatch =
            normCandTitle.includes(normReqTitle) ||
            normReqTitle.includes(normCandTitle);

        if (!titleMatch) {
            return {
                valid: false,
                reason: `Title mismatch: candidate title "${normCandTitle}" does not align with requested "${normReqTitle}"`,
                durationDiffSec,
            };
        }
    }

    return { valid: true, durationDiffSec };
}

// ============================================================================
// 4. Default Tier 1 Hi-Res Proxies
// ============================================================================

export const DEFAULT_TIER_1_PROXIES: ProxyEndpoint[] = [
    {
        name: 'Monochrome Primary HiFi (Tidal FLAC)',
        provider: 'monochrome',
        buildUrl: (track) => {
            const rawId = String(track.id).replace(/^(?:tracks|mono):(?:track:)?/, '');
            return `https://tracks.monochrome.st/track/${rawId}`;
        },
        quality: 'LOSSLESS',
        codec: 'flac',
        mimeType: 'audio/flac',
        lossless: true,
    },
    {
        name: 'Tidal Direct Stream Proxy',
        provider: 'tidal',
        buildUrl: (track, quality) => {
            const rawId = String(track.id).replace(/^(?:tracks|mono):(?:track:)?/, '');
            return `https://td.if-it-runs-ship-it.lol/api/v1/tracks/${rawId}/playbackinfo?audioquality=${encodeURIComponent(
                quality || 'LOSSLESS'
            )}&playbackmode=STREAM&assetpresentation=FULL`;
        },
        quality: 'LOSSLESS',
        codec: 'flac',
        mimeType: 'audio/flac',
        lossless: true,
    },
    {
        name: 'Deezer ISRC Lossless Proxy',
        provider: 'deezer',
        buildUrl: (track) => {
            if (!track.isrc) return '';
            return `https://dz.monochrome.st/stream/?isrc=${encodeURIComponent(
                track.isrc
            )}&format=FLAC`;
        },
        quality: 'LOSSLESS',
        codec: 'flac',
        mimeType: 'audio/flac',
        lossless: true,
    },
];

// ============================================================================
// 5. Tier 1 Stream Racer with 2.5s Timeout & 5xx Detection
// ============================================================================

/**
 * Checks whether an HTTP status is a 5xx server error (including Cloudflare 520-530).
 */
export function is5xxServerError(status: number): boolean {
    return (status >= 500 && status <= 599) || status === 530;
}

/**
 * Attempts to probe or fetch a single Tier 1 proxy endpoint with abort support.
 */
async function testTier1Proxy(
    proxy: ProxyEndpoint,
    track: TrackMetadata,
    quality: string,
    signal: AbortSignal
): Promise<{ url: string; proxy: ProxyEndpoint; latencyMs: number }> {
    const targetUrl = proxy.buildUrl(track, quality);
    if (!targetUrl) {
        throw new Error(`Proxy ${proxy.name} could not construct URL for track`);
    }

    const start = Date.now();

    // Use HEAD request to test availability, or GET if proxy rejects HEAD
    let response = await fetch(targetUrl, {
        method: 'HEAD',
        signal,
        headers: {
            'User-Agent': 'ArkVibe-Monochrome/2.5.1',
            Accept: 'audio/*, application/json',
        },
    });

    if (response.status === 405) {
        // Some proxies disallow HEAD; fallback to ranged GET for 1 byte
        response = await fetch(targetUrl, {
            method: 'GET',
            headers: {
                Range: 'bytes=0-1',
                'User-Agent': 'ArkVibe-Monochrome/2.5.1',
            },
            signal,
        });
    }

    const latencyMs = Date.now() - start;

    if (is5xxServerError(response.status)) {
        throw new Error(
            `Tier 1 proxy ${proxy.name} failed with 5xx status: ${response.status} ${response.statusText}`
        );
    }

    if (!response.ok && response.status !== 206) {
        throw new Error(
            `Tier 1 proxy ${proxy.name} returned non-ok status: ${response.status}`
        );
    }

    return {
        url: targetUrl,
        proxy,
        latencyMs,
    };
}

/**
 * Races Tier 1 proxies. If all return 5xx errors or fail within 2.5 seconds,
 * throws to allow fallback to Tier 2 (RapidAPI).
 */
export async function raceTier1Proxies(
    track: TrackMetadata,
    quality = 'LOSSLESS',
    proxies: ProxyEndpoint[] = DEFAULT_TIER_1_PROXIES,
    timeoutMs = 2500
): Promise<StreamResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(new Error(`Tier 1 race timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
        const eligibleProxies = proxies.filter((p) => Boolean(p.buildUrl(track, quality)));
        if (eligibleProxies.length === 0) {
            throw new Error('No eligible Tier 1 proxies available for this track');
        }

        // Race all Tier 1 proxies concurrently
        const winner = await Promise.any(
            eligibleProxies.map((proxy) =>
                testTier1Proxy(proxy, track, quality, controller.signal)
            )
        );

        // Cancel remaining requests
        controller.abort();

        return {
            url: winner.url,
            sourceUrl: winner.url,
            provider: winner.proxy.provider,
            quality: winner.proxy.quality,
            qualityDisplay: winner.proxy.lossless ? 'Hi-Res FLAC' : 'High',
            codec: winner.proxy.codec,
            mediaMimeType: winner.proxy.mimeType,
            playbackType: 'direct',
            lossless: winner.proxy.lossless,
            tier: 1,
            latencyMs: winner.latencyMs,
        };
    } finally {
        clearTimeout(timer);
    }
}

// ============================================================================
// 6. Tier 2: RapidAPI Fallback Provider with Strict Match Verification
// ============================================================================

/**
 * Queries RapidAPI endpoint for fallback track stream, enforcing strict
 * track length comparison (<= 3s) and artist matching.
 */
export async function fetchRapidApiFallback(
    track: TrackMetadata,
    options?: StreamResolverOptions
): Promise<StreamResult> {
    const { apiKey, apiHost, baseUrl } = getRapidApiConfig(options);

    if (!apiKey) {
        throw new Error(
            'RapidAPI fallback triggered, but RAPIDAPI_KEY environment variable is not configured.'
        );
    }

    const durationToleranceSec = options?.durationToleranceSec ?? 3.0;
    const cleanTitle = normalizeSongTitle(track.title);
    const cleanArtist = normalizeArtistName(track.artist || track.artists);
    const query = `${cleanArtist} ${cleanTitle}`.trim();

    console.warn(
        `[StreamResolver] Tier 1 proxies failed. Triggering Tier 2 RapidAPI fallback for: "${track.title}" by "${cleanArtist}"`
    );

    const start = Date.now();

    // Prepare search & stream resolution via RapidAPI
    const searchUrl = new URL(`${baseUrl}/search`);
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('limit', '5');

    const headers: Record<string, string> = {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': apiHost,
        Accept: 'application/json',
        'User-Agent': 'ArkVibe-Monochrome/2.5.1',
    };

    const res = await fetch(searchUrl.toString(), {
        method: 'GET',
        headers,
    });

    if (!res.ok) {
        throw new Error(
            `RapidAPI search failed with status: ${res.status} ${res.statusText}`
        );
    }

    const data = await res.json();

    // Support multiple common RapidAPI music response payload formats
    const items: RapidApiTrackItem[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.results)
          ? data.results
          : Array.isArray(data?.tracks)
            ? data.tracks
            : Array.isArray(data?.data)
              ? data.data
              : Array.isArray(data?.items)
                ? data.items
                : [];

    if (items.length === 0) {
        throw new Error(`RapidAPI returned no candidates for query "${query}"`);
    }

    // Evaluate candidates with strict verification
    for (const candidate of items) {
        const match = verifyTrackMatch(track, candidate, durationToleranceSec);

        if (!match.valid) {
            console.debug(`[StreamResolver] Discarding RapidAPI candidate: ${match.reason}`);
            continue;
        }

        // Extract stream or download link from candidate
        let streamUrl =
            candidate.streamUrl ||
            candidate.audioUrl ||
            candidate.downloadUrl ||
            candidate.url ||
            candidate.link;

        // If candidate requires an extra stream resolution step (e.g. download endpoint)
        if (!streamUrl && candidate.id) {
            const resolveUrl = new URL(`${baseUrl}/download`);
            resolveUrl.searchParams.set('id', String(candidate.id));

            const dlRes = await fetch(resolveUrl.toString(), { headers });
            if (dlRes.ok) {
                const dlData = await dlRes.json();
                streamUrl =
                    dlData.streamUrl ||
                    dlData.url ||
                    dlData.link ||
                    dlData.audioUrl ||
                    dlData.downloadUrl;
            }
        }

        if (streamUrl) {
            const latencyMs = Date.now() - start;
            console.info(
                `[StreamResolver] RapidAPI fallback accepted: "${candidate.title || candidate.name}" (delta: ${match.durationDiffSec.toFixed(1)}s, latency: ${latencyMs}ms)`
            );

            return {
                url: streamUrl,
                sourceUrl: streamUrl,
                provider: 'rapidapi',
                quality: 'HIGH',
                qualityDisplay: 'RapidAPI Verified (HQ)',
                codec: streamUrl.includes('.flac') ? 'flac' : 'mp3',
                mediaMimeType: streamUrl.includes('.flac') ? 'audio/flac' : 'audio/mpeg',
                playbackType: 'direct',
                lossless: streamUrl.includes('.flac'),
                tier: 2,
                latencyMs,
                matchedTrack: {
                    title: String(candidate.title || candidate.name || track.title),
                    artist: String(
                        typeof candidate.artist === 'object'
                            ? candidate.artist?.name
                            : candidate.artist || cleanArtist
                    ),
                    duration: normalizeDurationSeconds(
                        candidate.duration ?? candidate.duration_ms ?? candidate.length
                    ),
                    durationDiffSec: match.durationDiffSec,
                    id: candidate.id,
                },
            };
        }
    }

    throw new Error(
        `All RapidAPI candidates for "${query}" were discarded due to duration mismatch (>3s) or artist discrepancy.`
    );
}

// ============================================================================
// 7. Main Stream Resolution Controller
// ============================================================================

export class StreamResolver {
    private options: StreamResolverOptions;

    constructor(options: StreamResolverOptions = {}) {
        this.options = {
            tier1TimeoutMs: 2500,
            durationToleranceSec: 3.0,
            ...options,
        };
    }

    /**
     * Resolves audio stream using Tier 1 Hi-Res racing and automatic Tier 2 RapidAPI fallback.
     */
    async resolveStream(
        track: TrackMetadata,
        quality: AudioQuality | string = 'LOSSLESS'
    ): Promise<StreamResult> {
        const timeoutMs = this.options.tier1TimeoutMs ?? 2500;
        const proxies = this.options.customProxies || DEFAULT_TIER_1_PROXIES;

        try {
            // Tier 1: Primary Hi-Res Proxies (Tidal / Deezer via Monochrome) with 2.5s racing
            return await raceTier1Proxies(track, quality, proxies, timeoutMs);
        } catch (tier1Error: any) {
            console.warn(
                `[StreamResolver] Tier 1 Hi-Res stream race failed or timed out: ${tier1Error.message}. Switching to Tier 2 RapidAPI fallback.`
            );

            // Tier 2: RapidAPI Fallback
            try {
                return await fetchRapidApiFallback(track, this.options);
            } catch (rapidApiError: any) {
                throw new Error(
                    `Audio stream resolution completely failed. Tier 1 error: [${tier1Error.message}]; Tier 2 RapidAPI error: [${rapidApiError.message}]`
                );
            }
        }
    }
}

// Default singleton instance for simple imports
export const defaultStreamResolver = new StreamResolver();

/**
 * Functional entry point for stream resolution.
 */
export async function resolveTrackStream(
    track: TrackMetadata,
    quality: AudioQuality | string = 'LOSSLESS',
    options?: StreamResolverOptions
): Promise<StreamResult> {
    const resolver = options ? new StreamResolver(options) : defaultStreamResolver;
    return resolver.resolveStream(track, quality);
}

export default resolveTrackStream;

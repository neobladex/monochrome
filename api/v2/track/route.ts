/**
 * api/v2/track/route.ts
 *
 * Example API Endpoint Handler (Next.js App Router / Web Standard Request Handler)
 * Demonstrating usage of lib/stream.ts with RapidAPI fallback.
 */

import { resolveTrackStream, TrackMetadata } from '../../../lib/stream';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { track, quality } = body as {
            track: TrackMetadata;
            quality?: string;
        };

        if (!track || !track.title) {
            return new Response(
                JSON.stringify({ error: 'Missing track metadata (title is required).' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const streamResult = await resolveTrackStream(track, quality);

        return new Response(JSON.stringify(streamResult), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200',
            },
        });
    } catch (error: any) {
        return new Response(
            JSON.stringify({
                error: error.message || 'Stream resolution failed',
            }),
            { status: 502, headers: { 'Content-Type': 'application/json' } }
        );
    }
}

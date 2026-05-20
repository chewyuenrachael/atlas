/**
 * POST /api/queries/natural-language
 *
 * Accepts `{ question, chipId, userId }`. Hands off to the
 * `@atlas/api-ask-anything` package, which serves chip cache hits
 * instantly and routes free-form questions through Claude → Atlas SQL.
 *
 * Runs on the Node.js runtime — the executor uses the Supabase service
 * client which is not Edge-compatible.
 */
import { NextResponse } from 'next/server';
import { handleAsk, type AskRequest } from '@atlas/api-ask-anything';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  let body: AskRequest;
  try {
    body = (await request.json()) as AskRequest;
  } catch {
    return NextResponse.json(
      { ok: false, errorMessage: 'Body must be valid JSON.' },
      { status: 400 },
    );
  }
  const result = await handleAsk({
    ...(body.question !== undefined ? { question: body.question } : {}),
    ...(body.chipId !== undefined ? { chipId: body.chipId } : {}),
    ...(body.userId !== undefined ? { userId: body.userId } : {}),
  });
  // We always return 200; the response body carries `ok: false` for
  // application-level errors. This keeps the client-side handler simple.
  return NextResponse.json(result);
}

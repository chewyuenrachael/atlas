/**
 * `/ask` — Natural-language query interface for the Atlas.
 *
 * Server component. Loads the chip list (a static module export from
 * `@atlas/api-ask-anything`) and hands off interactive rendering to the
 * `AskClient` component.
 *
 * SPEC.md §7.3 — natural-language query interface ("Ask Anything").
 */
import { CHIPS } from '@atlas/api-ask-anything';
import { AskClient } from './AskClient';

export const metadata = {
  title: 'Ask Anything — Cursor Community Atlas',
};

export default function AskPage(): JSX.Element {
  return <AskClient chips={CHIPS} />;
}

/**
 * Cockpit root — redirects to the map. Phase 3 makes the map the primary
 * landing surface for the cockpit; the tables view remains accessible at
 * `/tables` for raw-data checks.
 */
import { redirect } from 'next/navigation';

export default function HomePage(): never {
  redirect('/map');
}

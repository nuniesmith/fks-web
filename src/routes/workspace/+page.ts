/**
 * The workspace dock is a client-only interaction model: dockview-core mounts
 * DOM elements imperatively and there is no meaningful server render, so we
 * disable SSR for this route. (Deep links to the other route-per-page surfaces
 * keep working with SSR unchanged.)
 */
export const ssr = false;

"use client";

import dynamic from "next/dynamic";

// next/dynamic with ssr:false is only allowed inside a Client Component -- app/dives/[id]/page.tsx
// (the only server-component consumer) can import and render this wrapper freely, it just can't
// call dynamic(..., { ssr: false }) itself. Leaflet touches window/document at module load, so it
// can never run during SSR either way.
export const DiveSiteMap = dynamic(
  () => import("@/components/dive-site-map").then((mod) => mod.DiveSiteMap),
  { ssr: false, loading: () => <div className="h-[220px] animate-pulse rounded-md border border-border bg-muted" /> },
);

import type { MetadataRoute } from "next";

/** A private instance: nothing for a crawler to index. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}

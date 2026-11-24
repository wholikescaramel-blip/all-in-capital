/** @type {import("next").NextConfig} */
export default {
  serverExternalPackages: [],
  // Uploaded PDFs travel through a server action; Vercel's request limit is about 4.5 MB.
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
};

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // vinext applies this limit to route-handler request bodies too, and it
      // defaults to 1 MB. Generated/edited images and the generator's
      // full-quality Final references are multi-MB (a 4K PNG is ~20 MB), so
      // 1 MB would 413 every real render. 32 MB comfortably covers a single
      // 4K image plus compressed references while staying well under the
      // Workers 100 MB body cap.
      bodySizeLimit: "32mb",
    },
  },
};

export default nextConfig;

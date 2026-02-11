/** @type {import('next').NextConfig} */
const path = require("path");

const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: path.join(__dirname, "../../..")
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb"
    }
  }
};
module.exports = nextConfig;

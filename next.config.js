const pkg = require('./package.json')

function looksLikeVersionRef(ref) {
  return Boolean(ref && /^v?\d+\.\d+/.test(ref))
}

function resolveAppVersion() {
  if (process.env.NEXT_PUBLIC_APP_VERSION) {
    return process.env.NEXT_PUBLIC_APP_VERSION
  }
  const vercelRef = process.env.VERCEL_GIT_COMMIT_REF
  if (looksLikeVersionRef(vercelRef)) {
    return vercelRef
  }
  const ghRef = process.env.GITHUB_REF_NAME
  if (looksLikeVersionRef(ghRef)) {
    return ghRef
  }
  return pkg.version
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@sparticuz/chromium', 'playwright-core'],
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: resolveAppVersion(),
  },
  reactStrictMode: true,
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'lastfm.freetls.fastly.net',
        pathname: '**',
      },
      {
        protocol: 'https',
        hostname: 'lastfm-img.freetls.fastly.net',
        pathname: '**',
      },
      {
        protocol: 'https',
        hostname: 'lastfm-img2.akamaized.net',
        pathname: '**',
      },
    ],
  },
}

module.exports = nextConfig

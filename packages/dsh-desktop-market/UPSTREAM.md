# Upstream provenance

`dsh-desktop-market` is maintained as a first-party DSH Desktop package.

- Initial source: `https://github.com/dsh-market/dsh-market`
- Initial tag: `v1.17.0`
- Initial commit: `69491bcee931949180eea54b77fe1053d4631780`
- License: MIT; see `LICENSE`

The initial Desktop client contains the embedded Plugins-page integration that was previously carried by `patches/dshmarket+1.17.0.patch`.

This package does not track dsh-market releases. Future upstream code is adopted file-by-file after review. The public catalog data format and source may continue to be consumed independently of upstream application releases.

The committed `lib/` and `client/` directories are the runtime artifacts. When source changes are intentionally adopted, rebuild them in an isolated dsh-market source checkout and copy only the reviewed output into this package; the Desktop root install must not acquire the market's build toolchain.

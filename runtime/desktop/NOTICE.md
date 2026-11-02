# Third-party components

noVNC is pinned to upstream 1.7.0. Setup downloads it and checks its SHA-256.
Its MPL-2.0 license and source files stay in the downloaded asset folder.

Xvfb, x11vnc, openbox, python3 and the X libraries come from the host's
distribution packages. Their copyright and license files stay where the
distribution installs them, usually `/usr/share/doc`. Google Chrome or Chromium
is the operator's own browser. None of these ship in this package.

cloudflared is a Cloudflare binary that setup downloads and checks. It is not
part of this package archive.

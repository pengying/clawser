# Third-party components

`chromium-seccomp.json` derives from the Moby default seccomp profile:
https://github.com/moby/profiles/blob/main/seccomp/default.json

The upstream profile is licensed under Apache-2.0; its license is included as
`MOBY-LICENSE`. Local modifications narrowly permit the namespace and chroot
operations required by Chromium's sandbox; the deployment verification records
the tested positive and negative syscall cases.

Chromium, Xvfb, x11vnc, Openbox and other image components are installed from
Debian packages, whose copyright/license files remain in `/usr/share/doc` inside
the image. noVNC is separately pinned to upstream1.7.0 with its MPL-2.0 license
and source files retained in the configured asset directory. cloudflared is an
operator-installed Cloudflare binary, not part of this package archive.

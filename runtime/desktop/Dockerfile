FROM debian@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
USER root
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium=156.0.8078.47-1~deb12u1 chromium-sandbox=156.0.8078.47-1~deb12u1 \
    fonts-dejavu-core fonts-liberation fonts-noto-cjk openbox python3 iptables util-linux \
    xvfb x11vnc xclip socat g++ libx11-dev libxres-dev libxtst-dev libxi-dev ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /bin/bash browser
RUN useradd --no-create-home --uid 1001 --shell /usr/sbin/nologin desktop-proxy
COPY x11-proof.cpp /opt/desktop/x11-proof.cpp
RUN g++ -std=c++17 -O2 -Wall -Wextra /opt/desktop/x11-proof.cpp -o /opt/desktop/x11-proof -lX11 -lXRes -lXtst -lXi && chmod 0555 /opt/desktop/x11-proof && install -d -o 1000 -g 1000 -m 0700 /profile
COPY supervisor.py /opt/desktop/supervisor.py
COPY entrypoint.sh /opt/desktop/entrypoint.sh
RUN chmod 0555 /opt/desktop/entrypoint.sh /opt/desktop/supervisor.py
ENV HOME=/home/browser DISPLAY=:1 LANG=C.UTF-8
WORKDIR /home/browser
EXPOSE 5900 9223
ENTRYPOINT ["/opt/desktop/entrypoint.sh"]

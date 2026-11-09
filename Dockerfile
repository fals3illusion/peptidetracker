# PeptideTracker container image.
# The release workflow runs `npm ci --omit=dev` first, so this image only copies files
# (no build steps): small, quick to build, and the same code as the Proxmox release.
FROM node:22-alpine
ENV NODE_ENV=production PORT=3080 DATA_DIR=/data PT_DOCKER=1
WORKDIR /app
COPY package.json package-lock.json server.js set-password.js CHANGELOG.md LICENSE ./
COPY lib ./lib
COPY public ./public
COPY grafana ./grafana
COPY node_modules ./node_modules
# Empty data folder owned by the app user (a named volume starts with this ownership).
COPY --chown=node:node docker/emptydata/ /data/
USER node
VOLUME /data
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["node", "-e", "fetch('http://127.0.0.1:3080/api/auth').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server.js"]

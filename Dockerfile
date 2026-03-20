FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY index.js .
ENV PORT=5001
EXPOSE 5001
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:5001/health || exit 1
CMD ["node", "index.js"]

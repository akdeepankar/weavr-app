FROM node:22-slim

WORKDIR /app

# Copy server code and static assets
COPY server/ ./server/
COPY public/ ./public/

# Ensure runtime generated directory exists
RUN mkdir -p public/generated

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "--experimental-strip-types", "server/api.ts"]

FROM node:24-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./
ENV PORT=8787 \
    DB_FILE=/app/data/data.db
VOLUME /app/data
EXPOSE 8787
CMD ["node", "index.js"]

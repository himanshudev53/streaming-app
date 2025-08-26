FROM node:22

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Set working directory
WORKDIR /app

# Copy package.json and install deps
COPY package*.json ./
RUN npm install

# Copy app files
COPY . .

# Build with esbuild
RUN npm run build

# Start server
CMD ["npm", "start"]

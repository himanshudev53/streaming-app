# FROM node:22

# # Install ffmpeg
# RUN apt-get update && apt-get install -y ffmpeg

# WORKDIR /app
# COPY package*.json ./
# RUN npm install
# COPY . .
# RUN npm run build

# CMD ["npm", "start"]

# Video Generator Backend

A Node.js Express application that generates video stories using OpenAI's GPT-3.5, DALL-E, and Text-to-Speech APIs.

## Prerequisites

- Node.js (v14 or higher)
- FFmpeg installed on your system
- AWS S3 bucket configured
- OpenAI API key

## Installation

1. Clone the repository
2. Install dependencies:
```bash
npm install
```

3. Copy example.env to .env and fill in your credentials:
```bash
cp example.env .env
```

4. Configure your environment variables in .env:
- OPENAI_API_KEY: Your OpenAI API key
- AWS_ACCESS_KEY_ID: Your AWS access key
- AWS_SECRET_ACCESS_KEY: Your AWS secret key
- AWS_REGION: Your AWS region
- AWS_BUCKET_NAME: Your S3 bucket name
- S3_BUCKET_URL: Your S3 bucket URL

## Running the Application

Development mode:
```bash
npm run dev
```

Production mode:
```bash
npm start
```

The server will start on port 3000 (or the port specified in your .env file).

## API Endpoints

### POST /generate
Generates a video story from a headline.

Request body:
```json
{
    "headline": "Your headline here",
    "target_duration": 30,
    "voice_type": "alloy"
}
```

Response:
```json
{
    "success": true,
    "message": "Video generated successfully",
    "video_url": "https://your-s3-bucket.com/videos/video_123456789.mp4"
}
```

## Rate Limiting

The API is rate-limited to 3 requests per hour per client.

## Error Handling

The API returns appropriate error messages and status codes:
- 400: Bad Request (missing parameters)
- 429: Too Many Requests (rate limit exceeded)
- 500: Internal Server Error

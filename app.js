const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { existsSync, createWriteStream } = require('fs');
const OpenAI = require('openai');
const { S3Client, PutObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const winston = require('winston');
const morgan = require('morgan');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();

// Configure logging
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' })
    ]
});

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use('/static', express.static('static'));

// Ensure required directories exist
const ensureDirectories = async () => {
    const dirs = ['static/videos', 'static/images', 'static/audio'];
    for (const dir of dirs) {
        await fsPromises.mkdir(dir, { recursive: true });
    }
};

ensureDirectories();

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour in milliseconds
const MAX_REQUESTS_PER_WINDOW = 3;
let requestHistory = [];

const checkRateLimit = () => {
    const currentTime = Date.now();
    requestHistory = requestHistory.filter(time => 
        currentTime - time < RATE_LIMIT_WINDOW
    );

    if (requestHistory.length >= MAX_REQUESTS_PER_WINDOW) {
        const oldestRequest = Math.min(...requestHistory);
        const resetTime = oldestRequest + RATE_LIMIT_WINDOW;
        const waitTime = resetTime - currentTime;
        const minutes = Math.ceil(waitTime / (60 * 1000));
        return {
            allowed: false,
            error: `Rate limit exceeded. Please try again in ${minutes} minutes.`
        };
    }

    requestHistory.push(currentTime);
    return { allowed: true };
};

const generateScript = async (headline, targetDuration) => {
    try {
        // Adjust word count for target duration
        const wordsPerSecond = 2.0; // Increased to get more content
        const targetWordCount = Math.floor(targetDuration * wordsPerSecond);

        const prompt = `Create a concise Instagram story script about ${headline}.
        Important requirements:
        1. The script MUST be exactly ${targetWordCount} words
        2. Create exactly 3 sentences that flow naturally
        3. DO NOT use any hashtags or social media tags
        4. Use simple, engaging language
        5. Each sentence should be descriptive and clear
        Style: Clear and engaging, like a story`;

        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }]
        });

        let script = response.choices[0].message.content.trim();
        
        // Strictly enforce word count
        script = script.split(' ')
            .filter(word => !word.startsWith('#'))
            .slice(0, targetWordCount)
            .join(' ');

        // Add strategic pauses to help reach target duration
        script = script.replace(/\. /g, '. <break time="0.3s"/> ');
        script = `<break time="0.2s"/> ${script} <break time="0.2s"/>`;

        logger.info(`Script generated with ${script.split(' ').length} words for ${targetDuration} seconds`);
        return { script, scriptParts: [script] };
    } catch (error) {
        logger.error(`Error generating script: ${error.message}`);
        throw error;
    }
};

const generateImage = async (prompt) => {
    logger.info(`Generating images for prompt: ${prompt}`);
    try {
        const images = [];
        const variations = [
            `Professional 4K photograph of ${prompt}, natural lighting, photojournalistic style, real-life scene`,
            `High-resolution documentary photograph of ${prompt}, captured in real location, natural colors, photorealistic`,
            `Candid photograph of ${prompt}, shot on professional camera, realistic lighting, authentic scene`
        ];

        for (let i = 0; i < 3; i++) {
            const basePrompt = variations[i];
            const fullPrompt = `${basePrompt}. Ensure photorealistic quality, no artificial or CGI elements, shot on professional camera with natural lighting. Style: photojournalism, documentary photography.`;

            const response = await openai.images.generate({
                model: "dall-e-3",
                prompt: fullPrompt,
                size: "1024x1024",
                quality: "hd",
                n: 1
            });

            const imageUrl = response.data[0].url;
            images.push(imageUrl);
            logger.info(`Image ${i + 1} generated successfully`);
        }

        return images;
    } catch (error) {
        logger.error(`Error generating image: ${error.message}`);
        throw error;
    }
};

const downloadImage = async (url, savePath) => {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);
        
        const buffer = await response.buffer();
        await fsPromises.writeFile(savePath, buffer);
        return savePath;
    } catch (error) {
        logger.error(`Error downloading image: ${error.message}`);
        throw error;
    }
};

const generateAudio = async (script, outputPath, voiceType = "alloy") => {
    logger.info("Starting audio generation");
    try {
        // Generate initial audio
        const response = await openai.audio.speech.create({
            model: "tts-1",
            voice: voiceType,
            input: script,
            response_format: "mp3",
            speed: 1.0
        });

        const buffer = Buffer.from(await response.arrayBuffer());
        await fsPromises.writeFile(outputPath, buffer);

        // Get initial audio duration
        const audioData = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(outputPath, (err, metadata) => {
                if (err) reject(err);
                else resolve(metadata);
            });
        });

        const audioDuration = audioData.format.duration;
        logger.info(`Initial audio duration: ${audioDuration.toFixed(2)} seconds`);

        // If audio is too long, speed it up to fit target duration
        if (audioDuration > 15.5) {
            const speedFactor = (audioDuration / 15).toFixed(2);
            logger.info(`Adjusting audio speed by factor ${speedFactor}`);

            const tempPath = `${outputPath}.temp.mp3`;
            await new Promise((resolve, reject) => {
                ffmpeg(outputPath)
                    .audioFilters(`atempo=${speedFactor}`)
                    .save(tempPath)
                    .on('end', async () => {
                        await fsPromises.rename(tempPath, outputPath);
                        resolve();
                    })
                    .on('error', reject);
            });

            // Verify final audio duration
            const finalData = await new Promise((resolve, reject) => {
                ffmpeg.ffprobe(outputPath, (err, metadata) => {
                    if (err) reject(err);
                    else resolve(metadata);
                });
            });

            const finalDuration = finalData.format.duration;
            logger.info(`Final audio duration after speed adjustment: ${finalDuration.toFixed(2)} seconds`);
        }

        logger.info("Audio generation completed successfully");
        return outputPath;
    } catch (error) {
        logger.error(`Error generating audio: ${error.message}`);
        if (existsSync(outputPath)) {
            await fsPromises.unlink(outputPath);
        }
        throw error;
    }
};

const createVideo = async (images, audioPath, outputPath, targetDuration) => {
    logger.info("Starting video creation process");
    const tempDir = path.join(__dirname, 'temp');
    const inputListPath = path.join(tempDir, 'input.txt');

    try {
        await fsPromises.mkdir(tempDir, { recursive: true });
        logger.info("Created temp directory");

        // Get audio duration
        const audioData = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(audioPath, (err, metadata) => {
                if (err) {
                    logger.error(`Error getting audio duration: ${err.message}`);
                    reject(err);
                    return;
                }
                resolve(metadata);
            });
        });

        const audioDuration = audioData.format.duration;
        logger.info(`Audio duration for video creation: ${audioDuration} seconds`);

        // Calculate duration per image to match audio duration
        const durationPerImage = Math.ceil((audioDuration / images.length) * 100) / 100;
        logger.info(`Duration per image: ${durationPerImage} seconds`);

        // Create input file for FFmpeg
        let inputFileContent = '';
        for (const image of images) {
            inputFileContent += `file '${path.resolve(image)}'\nduration ${durationPerImage}\n`;
        }
        inputFileContent += `file '${path.resolve(images[images.length - 1])}'`;

        logger.info("Writing input list file");
        await fsPromises.writeFile(inputListPath, inputFileContent);

        // Create video using FFmpeg
        logger.info("Starting FFmpeg process");
        const result = await new Promise((resolve, reject) => {
            const command = ffmpeg()
                .input(inputListPath)
                .inputOptions(['-f concat', '-safe 0'])
                .input(audioPath)
                .outputOptions([
                    '-c:v libx264',
                    '-pix_fmt yuv420p',
                    '-preset ultrafast',
                    '-r 30',
                    '-c:a aac',
                    '-strict experimental',
                    '-shortest'
                ])
                .on('start', (commandLine) => {
                    logger.info(`FFmpeg command: ${commandLine}`);
                })
                .on('progress', (progress) => {
                    logger.info(`FFmpeg progress: ${JSON.stringify(progress)}`);
                })
                .on('error', (err) => {
                    logger.error(`FFmpeg error: ${err.message}`);
                    reject(err);
                })
                .on('end', () => {
                    logger.info("FFmpeg process completed");
                    resolve(outputPath);
                });

            command.save(outputPath);
        });

        // Verify final video
        const outputData = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(outputPath, (err, metadata) => {
                if (err) reject(err);
                else resolve(metadata);
            });
        });

        const videoDuration = outputData.format.duration;
        logger.info(`Final video duration: ${videoDuration}s (target: ${targetDuration}s)`);

        // Clean up
        if (existsSync(inputListPath)) {
            await fsPromises.unlink(inputListPath);
            logger.info("Cleaned up input list file");
        }

        return result;
    } catch (error) {
        logger.error(`Error in createVideo: ${error.message}`);
        try {
            if (existsSync(inputListPath)) {
                await fsPromises.unlink(inputListPath);
                logger.info("Cleaned up input list file after error");
            }
        } catch (cleanupError) {
            logger.error(`Error during cleanup: ${cleanupError.message}`);
        }
        throw error;
    }
};

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    },
    maxAttempts: 5,
    retryMode: 'adaptive'
});

const uploadToS3 = async (filePath, key) => {
    try {
        logger.info(`Uploading ${filePath} to S3 with key ${key}`);
        
        // Read file as buffer
        const fileBuffer = await fsPromises.readFile(filePath);
        const fileSize = fileBuffer.length;
        logger.info(`File size: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`);

        // Start multipart upload
        const createMultipartUpload = await s3Client.send(new CreateMultipartUploadCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: key,
            ContentType: 'video/mp4'
        }));

        const uploadId = createMultipartUpload.UploadId;
        const partSize = 5 * 1024 * 1024; // 5MB parts
        const numParts = Math.ceil(fileSize / partSize);
        const uploadPromises = [];

        // Upload parts
        for (let i = 0; i < numParts; i++) {
            const start = i * partSize;
            const end = Math.min(start + partSize, fileSize);
            const partNumber = i + 1;

            const uploadPartCommand = new UploadPartCommand({
                Bucket: process.env.AWS_BUCKET_NAME,
                Key: key,
                UploadId: uploadId,
                PartNumber: partNumber,
                Body: fileBuffer.slice(start, end)
            });

            uploadPromises.push(
                s3Client.send(uploadPartCommand)
                    .then(response => ({
                        PartNumber: partNumber,
                        ETag: response.ETag
                    }))
            );

            logger.info(`Uploading part ${partNumber}/${numParts}`);
        }

        // Wait for all parts to upload
        const uploadResults = await Promise.all(uploadPromises);

        // Complete multipart upload
        await s3Client.send(new CompleteMultipartUploadCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
                Parts: uploadResults
            }
        }));

        const url = `${process.env.S3_BUCKET_URL}/${key}`;
        logger.info(`File uploaded successfully to ${url}`);

        // Delete local file after successful upload
        try {
            await fsPromises.unlink(filePath);
            logger.info(`Local file deleted: ${filePath}`);
        } catch (deleteError) {
            logger.warn(`Failed to delete local file: ${deleteError.message}`);
            // Don't throw error here as upload was successful
        }

        return url;
    } catch (error) {
        logger.error(`Error uploading to S3: ${error.message}`);
        
        // Try to clean up local file even if upload failed
        try {
            await fsPromises.unlink(filePath);
            logger.info(`Local file deleted after failed upload: ${filePath}`);
        } catch (deleteError) {
            logger.warn(`Failed to delete local file after upload error: ${deleteError.message}`);
        }
        
        throw error;
    }
};

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});

app.get('/static/videos/:filename', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'videos', req.params.filename));
});

app.post('/generate', async (req, res) => {
    const { headline, target_duration, voice_type } = req.body;

    // Validate required fields
    if (!headline || !target_duration || !voice_type) {
        return res.status(400).json({ 
            success: false,
            error: "Headline, target_duration, and voice_type are required" 
        });
    }

    // Validate target_duration
    const duration = parseInt(target_duration);
    if (isNaN(duration) || duration < 5 || duration > 60) {
        return res.status(400).json({ 
            success: false,
            error: "Target duration must be between 5 and 60 seconds" 
        });
    }

    // Validate voice_type
    const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
    if (!validVoices.includes(voice_type)) {
        return res.status(400).json({ 
            success: false,
            error: `Voice type must be one of: ${validVoices.join(', ')}` 
        });
    }

    const rateLimitResult = checkRateLimit();
    if (!rateLimitResult.allowed) {
        return res.status(429).json({ 
            success: false,
            error: rateLimitResult.error 
        });
    }

    try {
        logger.info(`Starting video generation - Headline: ${headline}, Duration: ${duration}s, Voice: ${voice_type}`);

        // Ensure directories exist
        await Promise.all([
            fsPromises.mkdir('static/images', { recursive: true }),
            fsPromises.mkdir('static/audio', { recursive: true }),
            fsPromises.mkdir('static/videos', { recursive: true })
        ]);

        // Generate script with target duration
        const scriptResult = await generateScript(headline, duration);
        logger.info('Script generated successfully');

        // Generate and download images
        const images = await generateImage(scriptResult.script);
        logger.info(`Generated ${images.length} images`);

        const downloadedImages = await Promise.all(images.map((url, i) => {
            const savePath = path.join('static', 'images', `image_${i + 1}.png`);
            return downloadImage(url, savePath);
        }));
        logger.info('All images downloaded successfully');

        // Generate audio with specified voice type
        const audioPath = path.join('static', 'audio', `audio_${Date.now()}.mp3`);
        await generateAudio(scriptResult.script, audioPath, voice_type);
        logger.info('Audio generated successfully');

        // Create video with target duration
        const videoPath = path.join('static', 'videos', `output_${Date.now()}.mp4`);
        await createVideo(downloadedImages, audioPath, videoPath, duration);
        logger.info('Video created successfully');

        // Verify video file exists and is valid
        const videoStats = await fsPromises.stat(videoPath);
        if (!videoStats.size) {
            throw new Error('Generated video file is empty');
        }

        // Verify video file using ffprobe
        await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(videoPath, (err, metadata) => {
                if (err) {
                    reject(new Error(`Invalid video file generated: ${err.message}`));
                    return;
                }
                if (!metadata.format) {
                    reject(new Error('Generated video has invalid format'));
                    return;
                }
                
                const videoDuration = metadata.format.duration;
                // Allow for some flexibility in duration (±20%)
                const targetDuration = duration;
                const minDuration = targetDuration * 0.8;
                const maxDuration = targetDuration * 1.2;
                
                logger.info(`Video verification - Target: ${targetDuration}s, Actual: ${videoDuration}s`);
                
                if (videoDuration < minDuration) {
                    reject(new Error(`Video is too short (${videoDuration.toFixed(1)}s vs target ${targetDuration}s)`));
                    return;
                }
                if (videoDuration > maxDuration) {
                    reject(new Error(`Video is too long (${videoDuration.toFixed(1)}s vs target ${targetDuration}s)`));
                    return;
                }
                
                logger.info(`Video duration verification passed: ${videoDuration.toFixed(1)} seconds`);
                resolve();
            });
        });

        // Upload to S3
        const s3Key = `videos/output-${Date.now()}.mp4`;
        const s3Url = await uploadToS3(videoPath, s3Key);
        logger.info('Video uploaded to S3 successfully');

        // Clean up files asynchronously
        const cleanup = async () => {
            try {
                await Promise.all([
                    ...downloadedImages.map(path => fsPromises.unlink(path).catch(e => logger.error(`Error deleting image: ${e}`))),
                    fsPromises.unlink(audioPath).catch(e => logger.error(`Error deleting audio: ${e}`)),
                    fsPromises.unlink(videoPath).catch(e => logger.error(`Error deleting video: ${e}`))
                ]);
                logger.info('Cleanup completed successfully');
            } catch (error) {
                logger.error(`Error during cleanup: ${error.message}`);
            }
        };
        cleanup(); // Don't await cleanup to speed up response

        res.json({
            success: true,
            message: "Video generated successfully",
            video_url: s3Url,
            duration: duration,
            voice_type: voice_type
        });
    } catch (error) {
        logger.error(`Error in video generation: ${error.message}`);
        res.status(500).json({ 
            success: false,
            error: error.message || "An error occurred during video generation" 
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
});

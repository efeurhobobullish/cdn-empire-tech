const fastifyRateLimit = require("@fastify/rate-limit");
const fastifyMultipart = require("@fastify/multipart");
const FileType = require("file-type");
const stream = require("stream");
const mega = require("./mega.js");
const config = require("../config.js");
const fastifyCors = require("@fastify/cors");
const fastifyStatic = require("@fastify/static");
const path = require("path");
const mongoose = require("mongoose");
const Mega = require("megajs");

// Configure Fastify with JSON spaces for pretty-printed responses
const fastify = require("fastify")({
  logger: {
    level: "info",
    transport: {
      target: "pino-pretty",
      options: { colorize: true },
    },
  },
  jsonSpaces: 2, // Pretty-print JSON responses with 2 spaces
});

// Connect to MongoDB
mongoose.connect(config.MONGO_URI)
  .then(() => console.log('Connected to MongoDB Atlas DataBase'))
  .catch(err => console.error('Error Connecting to MongoDB Atlas:', err));

// Define File schema
const fileSchema = new mongoose.Schema({
  originalFileName: { type: String, required: true, unique: true }, // Ensure originalFileName is required and unique
  megaFileName: { type: String, required: true }
});

const File = mongoose.model('File', fileSchema);

// Register plugins
fastify.register(fastifyCors, { origin: "*", methods: ["GET", "POST"] });
fastify.register(fastifyRateLimit, {
  global: true,
  max: 100,
  timeWindow: "1 minute",
  addHeaders: {
    "x-ratelimit-limit": true,
    "x-ratelimit-remaining": true,
    "x-ratelimit-reset": true,
    "retry-after": true,
  },
});

fastify.register(fastifyMultipart, {
  limits: { fileSize: config.server.maxFileSize, files: 10 },
});

fastify.register(fastifyStatic, { root: path.join(__dirname, '../public'), prefix: "/" });

fastify.addHook("onSend", (request, reply, payload, done) => {
  if (request.url.startsWith("/file")) {
    reply.header("Cache-Control", `public, max-age=${config.server.cacheTTL}`);
  }
  done();
});

// Serve index.html at root
fastify.get("/", async (request, reply) => {
  return reply.sendFile('index.html');
});

// GET /keep-alive
fastify.get('/keep-alive', async (request, reply) => {
  return {
    status: 200,
    success: true,
    creator: 'Empire Tech',
    result: 'Keeping this Uploader Alive'
  };
});


fastify.post("/api/upload.php", async (request, reply) => {
  var files = [];
  try {
    for await (var part of request.parts()) {
      if (!part.file) continue;

      if (part.file.truncated) {
        throw new Error(`File size exceeds the limit of ${config.server.maxFileSize} bytes`);
      }

      var buffer = await part.toBuffer();
      var fileType = await FileType.fromBuffer(buffer);

      if (!fileType || !config.server.allowedTypes.includes(fileType.mime)) {
        throw new Error(`File type not allowed: ${fileType?.mime || "unknown"}`);
      }

      // Extract the original file name from the form data
      const originalFileName = part.fields.originalFileName.value;

      // Check if a file with the same name already exists in the database
      const existingFile = await File.findOne({ originalFileName });
      if (existingFile) {
        return {
          status: 409, // Conflict status code
          success: false,
          message: "File Already Exists in Database",
          file: {
            file_name: `${originalFileName}`,
            stream_url: `${config.server.domain}/file/${originalFileName}`,
            download_url: `${config.server.domain}/file/download/${originalFileName}`,
            delete_url: `${config.server.domain}/file/delete/${originalFileName}`,
            name: originalFileName,
            size: existingFile.size,
            mime: existingFile.mime,
          },
        };
      }

      var Myr = Math.random().toString(36).substring(2, 8);
      var date = new Date();
      var fixedDate = `${date.getDate()}_${date.getMonth() + 1}_${date.getFullYear()}`;
      var filename = `${fixedDate}_${Myr}.${fileType.ext || "bin"}`;
      var fileStream = new stream.PassThrough();
      fileStream.end(buffer);

      files.push({ filename, stream: fileStream, mime: fileType.mime, originalFileName });
    }

    var uploads = await Promise.all(
      files.map((file) => mega.uploadFile(file.filename, file.stream))
    );

    // Save original file name and MEGA file string to MongoDB
    for (const upload of uploads) {
      const originalFileName = files[0].originalFileName; // Use the original file name from the form data
      const megaFileName = upload.url.replace(/^https:\/\/mega\.nz\/file\//, ""); // Only remove the prefix

      const newFile = new File({
        originalFileName,
        megaFileName,
        size: upload.size,
        mime: upload.mime,
      });

      await newFile.save();
    }

    return {
      status: 200,
      success: true,
      creator: 'GiftedTech',
      files: uploads.map((upload) => ({
        file_name: `${files[0].originalFileName}`,
        stream_url: `${config.server.domain}/file/${files[0].originalFileName}`,
        download_url: `${config.server.domain}/file/download/${files[0].originalFileName}`,
        delete_url: `${config.server.domain}/file/delete/${files[0].originalFileName}`,
        name: files[0].originalFileName,
        size: upload.size,
        mime: upload.mime,
      })),
    };
  } catch (error) {
    request.log.error(error);
    reply.code(400).send({ success: false, error: error.message });
  }
});


// Force Streaming File
fastify.get("/file/*", async (request, reply) => {
  try {
    const originalFileName = request.params['*'];

    // Find file in MongoDB
    const fileRecord = await File.findOne({ originalFileName });
    if (!fileRecord) {
      return reply.code(404).send({
        status: 'error',
        message: 'File not found'
      });
    }

    const megaFileName = fileRecord.megaFileName;
    const fileUrl = `https://mega.nz/file/${megaFileName}`;

    const file = Mega.File.fromURL(fileUrl);
    await file.loadAttributes();

    // headers
    reply.header('Content-Type', file.mime);
    reply.header('Content-Length', file.size);
    reply.header('Cache-Control', `public, max-age=${config.server.cacheTTL}`);
    reply.header('Content-Disposition', `inline; filename="${originalFileName}"`);

    const downloadStream = file.download();
    downloadStream.on('error', (error) => {
      request.log.error('Stream error:', error);
      if (!reply.sent) {
        reply.code(500).send({
          status: 'error',
          message: 'Streaming failed',
          error: error.message
        });
      }
    });
    return reply.send(downloadStream);

  } catch (error) {
    request.log.error('Serve error:', error);
    return reply.code(500).send({
      status: 'error',
      message: 'Failed to serve file',
      error: error.message
    });
  }
});


// Force Downloading File
fastify.get("/file/download/*", async (request, reply) => {
  try {
    const originalFileName = request.params['*']; // Get the original file name from the URL

    // Find the corresponding MEGA file string in MongoDB
    const fileRecord = await File.findOne({ originalFileName });
    if (!fileRecord) {
      throw new Error("File not found in database");
    }

    const megaFileName = fileRecord.megaFileName; // Get the MEGA file string (including # or @)
    const fileUrl = `https://mega.nz/file/${megaFileName}`; // Construct MEGA URL with the saved string

    // Load the file from MEGA
    const file = Mega.File.fromURL(fileUrl);
    await file.loadAttributes();

    // Set response headers
    reply.header("Content-Type", file.mime);
    reply.header("Content-Disposition", `attachment; filename="${file.name}"`); // Force download

    // download the file from MEGA
    return reply.send(file.download());
  } catch (error) {
    request.log.error(error);
    reply.code(404).send({ success: false, error: "File not found or failed to load" });
  }
});


fastify.get("/file/delete/*", async (request, reply) => {
    try {
        const originalFileName = decodeURIComponent(request.params['*']).trim(); // Decode and trim
        console.log("Requested File:", originalFileName);

        // Find the file in MongoDB
        const fileRecord = await File.findOne({ originalFileName });
        if (!fileRecord) {
            throw new Error("File not found in database");
        }

        // Delete from MongoDB only
        await File.findOneAndDelete({ originalFileName });

        reply.header("Cache-Control", "no-store");
        return {
            status: 200,
            success: true,
            creator: 'GiftedTech',
            message: `File "${originalFileName}" Deleted Successfully from the Database.`,
        };
    } catch (error) {
        console.error("Error:", error.message);
        reply.code(404).send({ success: false, error: error.message });
    }
});


async function start() {
  try {
    await mega.initialize();
    fastify.listen({ port: config.server.port, host: "0.0.0.0" });
    console.log(`Running at ${config.server.domain}:${config.server.port}`);
  } catch (error) {
    fastify.log.error(error);
    console.log("EXITING");
    process.exit(1);
  }
}

start();

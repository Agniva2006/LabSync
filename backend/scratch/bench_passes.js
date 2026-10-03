const faceapi = require('@vladmandic/face-api');
const path = require('path');
const fs = require('fs');
const { Image, ImageData, loadImage } = require('@napi-rs/canvas');

const SafeCanvas = class extends require('@napi-rs/canvas').Canvas {
  constructor(width = 0, height = 0) { super(Math.max(0, width || 0), Math.max(0, height || 0)); }
};

faceapi.env.monkeyPatch({
  Canvas: SafeCanvas,
  Image,
  ImageData,
  createCanvas: (w = 0, h = 0) => require('@napi-rs/canvas').createCanvas(Math.max(0, w || 0), Math.max(0, h || 0)),
});

(async () => {
  const m = path.resolve(__dirname, '../models');
  await faceapi.nets.tinyFaceDetector.loadFromDisk(m);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(m);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(m);
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(m);

  const img = await loadImage(fs.readFileSync(path.join(__dirname, 'noface_qvga.jpg')));

  const bench = async (label, fn) => {
    const t = Date.now();
    const r = await fn();
    console.log(`${label}: ${Date.now() - t}ms -> ${r ? 'HIT' : 'null'}`);
    return Date.now() - t;
  };

  // Warm-up so first-call graph/kernel setup is not counted
  await bench('warmup tiny(224)', () => faceapi.detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.15 })));

  await bench('tiny 224 detect-only   ', () => faceapi.detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.15 })));
  await bench('tiny 160 detect-only   ', () => faceapi.detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.10 })));
  await bench('ssd  detect-only       ', () => faceapi.detectSingleFace(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.15 })));

  // Full chain cost on a real face
  const faceImg = await loadImage(fs.readFileSync(path.join(__dirname, '../face.jpg')));
  await bench('FULL chain tiny224+l68+fr (face)', () => faceapi
    .detectSingleFace(faceImg, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.15 }))
    .withFaceLandmarks().withFaceDescriptor());

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
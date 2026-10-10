const assert = require("assert");
const api = require("../image-api.cjs");

const boundary = "----MangosteenTestBoundary";
const body = api.buildImageEditMultipart({
  model: "gpt-image-2",
  prompt: "keep the same character",
  size: "1024x1024",
  quality: "high",
  output_format: "png",
  images: [
    { name: "character.png", type: "image/png", buffer: Buffer.from("character") },
    { name: "clothes.jpg", type: "image/jpeg", buffer: Buffer.from("clothes") },
    { name: "scene.webp", type: "image/webp", buffer: Buffer.from("scene") },
  ],
}, boundary).toString("utf8");

const occurrences = (value) => body.split(value).length - 1;

assert.strictEqual(occurrences('name="image[]"'), 3);
for (const field of ["model", "prompt", "size", "quality", "output_format"]) {
  assert.strictEqual(occurrences(`name="${field}"`), 1);
}

const singleImageBody = api.buildImageEditMultipart({
  prompt: "single image",
  image: { name: "single.png", type: "image/png", buffer: Buffer.from("single") },
}, boundary).toString("utf8");
assert.strictEqual(singleImageBody.split('name="image[]"').length - 1, 1);

assert.throws(() => api.buildImageEditMultipart({ images: [] }, boundary), /1.*4/);
assert.throws(() => api.buildImageEditMultipart({
  images: Array.from({ length: 5 }, (_, index) => ({
    name: `image-${index}.png`, type: "image/png", buffer: Buffer.from(String(index)),
  })),
}, boundary), /1.*4/);

const fingerprint = api.createSubmissionFingerprint({
  mode: "edit", prompt: "same character", image: Buffer.from("character"),
});
assert.match(fingerprint, /^sha256:[a-f0-9]{64}$/);
assert.strictEqual(fingerprint, api.createSubmissionFingerprint({
  image: Buffer.from("character"), prompt: "same character", mode: "edit",
}));
assert.notStrictEqual(fingerprint, api.createSubmissionFingerprint({
  mode: "edit", prompt: "same character", image: Buffer.from("changed-character"),
}));

console.log("image-api: ok");

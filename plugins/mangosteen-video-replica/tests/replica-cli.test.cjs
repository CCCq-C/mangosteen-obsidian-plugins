const assert = require("assert");
const { transcriptSegments, hasFrameCoverage } = require("../replica-cli.cjs");

assert.deepStrictEqual(transcriptSegments({
  transcription: [{ timestamps: { from: "00:00:00,000", to: "00:00:07,000" }, text: "(字幕製作:貝爾)" }],
}), []);

assert.deepStrictEqual(transcriptSegments({
  transcription: [{ offsets: { from: 1500, to: 3200 }, text: "今天我们来看这款产品。" }],
}), [{ start: 1.5, end: 3.2, text: "今天我们来看这款产品。" }]);

assert.strictEqual(hasFrameCoverage([0, 2, 22, 74, 105], 133), false);
assert.strictEqual(hasFrameCoverage([0, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 132], 133), true);

console.log("replica-cli: ok");

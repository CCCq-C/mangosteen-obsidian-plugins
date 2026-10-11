const assert = require("assert");
const {
  DEFAULT_VISUAL_STYLE,
  applyVisualStyle,
  normalizeVisualStyle,
  visualStyleBlock,
} = require("../visual-style.cjs");

const style = normalizeVisualStyle({
  category: "二次元写实",
  prompt: "二次元写实角色，真实电影光影，低饱和暖色调，禁止卡通扁平化。",
}, { required: true });

assert.deepStrictEqual(style, {
  category: "二次元写实",
  prompt: "二次元写实角色，真实电影光影，低饱和暖色调，禁止卡通扁平化。",
});
assert.match(visualStyleBlock(style), /【项目视觉风格】/);
assert.match(visualStyleBlock(style), /类型：二次元写实/);
assert.match(applyVisualStyle("人物走入客厅。", style), /人物走入客厅/);
assert.strictEqual((applyVisualStyle("人物走入客厅。", style).match(/【项目视觉风格】/g) || []).length, 1);
assert.strictEqual(
  (applyVisualStyle(applyVisualStyle("人物走入客厅。", style), style).match(/【项目视觉风格】/g) || []).length,
  1,
  "style injection must be idempotent",
);
assert.deepStrictEqual(normalizeVisualStyle(null), DEFAULT_VISUAL_STYLE);
assert.throws(() => normalizeVisualStyle({ category: "真人写实", prompt: "" }, { required: true }), /视觉风格描述/);

console.log("visual-style: ok");

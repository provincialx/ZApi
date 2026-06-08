export const FORGETMEAI_WATERMARK =
  "mandrykinsergey@gmail.com | twitch.tv/dnovitv";

export function printForgetMeAiWatermark() {
  console.log(`\nForgetMeAI: ${FORGETMEAI_WATERMARK}\n`);
}

export function formatForgetMeAiWatermark(prefix = "ForgetMeAI") {
  return `${prefix}: ${FORGETMEAI_WATERMARK}`;
}

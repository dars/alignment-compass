// 背景工作：Vercel 上用 waitUntil 讓 function 在回應後繼續執行；
// 本機長駐 server 則讓 promise 自然完成
let waitUntilFn = null;
try {
  ({ waitUntil: waitUntilFn } = await import("@vercel/functions"));
} catch {}

export function defer(promise) {
  const guarded = Promise.resolve(promise).catch((err) =>
    console.error("背景工作失敗：", err?.message || err)
  );
  if (waitUntilFn) {
    try {
      waitUntilFn(guarded);
      return;
    } catch {}
  }
  // fallback：不 await，讓事件迴圈自行完成
}

// image.ts — sharp 图片处理：封面→1x JPEG、视觉喂图 shrink
import sharp from 'sharp';

// 封面压到设计稿 1x 喂视觉模型；viewport 缺失时按最长边 1024 兜底
export async function coverTo1xJpeg(buf: Buffer, viewportW: number, viewportH: number): Promise<Buffer> {
  let pipeline = sharp(buf);
  if (viewportW > 0 && viewportH > 0) {
    // contain 等比缩放后，空出的边缘用白色填充（与最终 JPEG flatten 白底一致），避免拉伸失真
    pipeline = pipeline.resize(Math.round(viewportW), Math.round(viewportH), {
      fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 },
    });
  } else {
    pipeline = pipeline.resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true });
  }
  return pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 80 }).toBuffer();
}

// 默认 1568；DeepSeek 进模型前只保留约 800×800 等效像素，设 LANHU_VISION_MAX_EDGE=1024 可再省流量
const DEFAULT_MAX_SIDE = Number(process.env.LANHU_VISION_MAX_EDGE) || 1568;

export async function shrinkForVision(buf: Buffer, maxSide = DEFAULT_MAX_SIDE): Promise<Buffer> {
  return sharp(buf)
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer();
}

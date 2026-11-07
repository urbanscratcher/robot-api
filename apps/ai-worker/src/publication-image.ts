export async function preparePublicationImage(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw Error('JPG·PNG·WebP 이미지를 선택하세요.');
  if (file.size > 20 * 1024 * 1024) throw Error('원본 이미지는 20MB 이하로 선택하세요.');
  const image = await createImageBitmap(file);
  try {
    if (image.width * image.height > 40_000_000) throw Error('이미지가 너무 큽니다. 4천만 화소 이하로 줄여주세요.');
    const ratio = Math.max(0.8, Math.min(1.9, image.width / image.height));
    const canvas = document.createElement('canvas');
    canvas.width = 1080; canvas.height = Math.round(1080 / ratio);
    const context = canvas.getContext('2d'); if (!context) throw Error('이미지를 변환할 수 없습니다. 다른 브라우저에서 다시 시도하세요.');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / image.width, canvas.height / image.height);
    const width = image.width * scale, height = image.height * scale;
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    return canvas.toDataURL('image/jpeg', 0.9);
  } finally { image.close(); }
}

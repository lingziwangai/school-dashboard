"""图片上传处理：校验、压缩、去 EXIF。

安全要点：
- 文件名由服务端生成（uuid），绝不使用客户端提供的文件名。
- 按 magic bytes 判断类型，白名单 jpeg/png/webp，拒绝 SVG（可携带脚本）与 GIF。
- 剥离 EXIF：学校活动照片常带 GPS，属隐私雷区。
"""
from __future__ import annotations

import io
import uuid
from pathlib import Path

from PIL import Image, ImageFile, UnidentifiedImageError

from .db import MEDIA_DIR, now_iso

ImageFile.LOAD_TRUNCATED_IMAGES = True
Image.MAX_IMAGE_PIXELS = 80_000_000

MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_DIMENSION = 1600
ALLOWED_MIME = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}


class UploadError(Exception):
    pass


def _sniff(fmt: str) -> str:
    mime = ALLOWED_MIME.get(fmt)
    if mime is None:
        raise UploadError("只支持 JPG / PNG / WebP 格式的图片")
    return mime


def save_image(raw: bytes, original_name: str = "") -> dict:
    if not raw:
        raise UploadError("文件是空的")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise UploadError("图片太大了，请压缩到 8MB 以内")

    try:
        probe = Image.open(io.BytesIO(raw))
        fmt = (probe.format or "").upper()
        probe.verify()
    except (UnidentifiedImageError, OSError):
        raise UploadError("这不是一张有效的图片")

    mime = _sniff(fmt)

    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError):
        raise UploadError("图片读取失败，请换一张试试")

    # 统一转成 RGB（PNG 的透明通道转成白色底）
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        background = Image.new("RGB", img.size, (255, 255, 255))
        background.paste(img, mask=img.split()[-1])
        img = background
    elif img.mode != "RGB":
        img = img.convert("RGB")

    if max(img.size) > MAX_DIMENSION:
        ratio = MAX_DIMENSION / max(img.size)
        img = img.resize(
            (max(1, int(img.width * ratio)), max(1, int(img.height * ratio))),
            Image.LANCZOS,
        )

    # 重新编码即等于丢掉 EXIF
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=82, optimize=True)
    data = out.getvalue()

    filename = f"{uuid.uuid4().hex}.jpg"
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    path = MEDIA_DIR / filename
    path.write_bytes(data)

    return {
        "filename": filename,
        "path": str(path),
        "mime": "image/jpeg",
        "width": img.width,
        "height": img.height,
        "bytes": len(data),
        "original_name": original_name,
        "created_at": now_iso(),
    }


def media_path(filename: str) -> Path:
    """只允许访问 media 目录下的文件名，防止路径穿越。"""
    safe = Path(filename).name
    if safe != filename or not safe:
        raise UploadError("非法的文件名")
    return MEDIA_DIR / safe

# 角色素材

生成/编辑方式：内置 imagegen。未调用 CLI。

`dist/assets/naiwa.webp`、`renbo.webp`、`chaorui.webp` 来自上一版用户批准的角色形象。

`dist/assets/food-supplier.webp` 为本次新增食物供应商。保留原图发型、灰色衣服、手机姿势与动漫截图风格，移除背景及底部字幕；透明 PNG 原件位于 `C:/Users/wzl/Desktop/CODE2/ocean-trader/characters/food-supplier.png`，发布版本转换为透明 WebP。

## 本次供应商处理提示词

Use case: background-extraction / identity-preserve. Asset type: transparent 2D dialogue portrait and island food-vendor sprite for an existing game. Edit target: attached image of the anime-style young man in front of a pork-rice stall. Extract ONLY the anime character as a clean waist-up to hips cutout. Preserve the same recognizable face, dark spiky hair, serious expression, sleeveless open gray top, white abdominal wraps, blue-gray waist rope, and the hand holding the dark smartphone. Preserve the exact existing flat anime screenshot illustration style; do not convert to 3D, photorealism, chibi or a different character design. Remove all food-stall background, signage, tables, steam, and the bottom overlaid Chinese meme subtitle. Reconstruct only the small parts of his torso/waist obscured by that subtitle with consistent clothing. Keep the head, hair tips, arm, phone and waist fully within frame, centered with a small transparent margin. No text, no extra props or people, no floor, no frame. Actual alpha transparency.

## 豪自透明立绘

`dist/assets/haozi.webp` 使用内置 ImageGen 根据用户参考照片制作，PNG 源文件保留在 `C:/Users/wzl/.codex/generated_images/01a14943-3321-72e3-92a5-89d7ea4d3beb/exec-ea57cb6b-239a-4ab1-ba4c-17cbed5accc6.png`，发布版本转换为透明 WebP。

提示词摘要：保留人物可识别的面部特征、圆形金属框眼镜、深色卷发、平静表情、灰色连帽衫和蓝色内搭；移除室内背景与左侧残留人物；自然补全上半身，保持照片质感，不转换为卡通或 3D；居中半身像，无文字、无道具，输出透明 PNG。

发布优化：所有角色立绘统一缩放至最大边 640 像素并转为 WebP（质量 70），网页资源从约 14.7 MB 降至约 0.33 MB；`scripts/optimize_assets.py` 可重复执行这一流程。

## 粉红蛙透明立绘

`dist/assets/pink-frog.webp` 使用内置 ImageGen 根据用户提供的泳池边粉色角色参考图制作。透明 PNG 源文件位于 `C:/Users/wzl/.codex/generated_images/01a14943-3321-72e3-92a5-89d7ea4d3beb/exec-69d76558-f4b6-4407-b7c0-52d084a83905.png`，发布版本缩放为 640×640 WebP（质量 70）。

提示词摘要：保留粉色圆润角色、绿色大眼睛、粉色猫耳针织帽和坐姿，去除泳池、瓷砖、水面与其他背景，只保留角色全身并输出真实透明背景；不添加文字、道具或其他人物。

## 肥嘟嘟透明立绘

`dist/assets/feidudu.webp` 使用内置 ImageGen 根据用户提供的黄色外卖员角色参考图制作。透明 PNG 源文件位于 `C:/Users/wzl/.codex/generated_images/01a14943-3321-72e3-92a5-89d7ea4d3beb/exec-e70df371-a6f0-45f9-8ea7-15dcbcc1dacc.png`，发布版本清理零散透明像素后缩放为最长边 640 像素的 WebP（质量 70）。

提示词摘要：保留黄色四足身体、黑色头部、圆眼、红鼻子、长耳朵、背带和黄色配送箱，移除白色背景及箱体品牌文字，保持原有可爱简化 3D 吉祥物比例，输出透明背景完整角色。


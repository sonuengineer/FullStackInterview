# Multimodal RAG & Vision AI

## Prompting with images

> Extended (slow track only) | Slow CP5 only | ~1.2 h

Messages API mein image ek **content block** hai, text ke saath same `user` message mein: `{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "<base64>"}}`. Poori PDF ke liye `{"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "<base64>"}}` -- PDF ke pages text aur image dono tarah process hote hain.
Good practice: image pehle, sawaal baad mein; batao image kya hai ("scanned invoice, page 2 of 4"); output structured maango (M05-06 JSON schema) aur likho "field dikh nahi raha to null do, guess mat karo".
Zaroori region pe **crop** karke bhejo (M08-11 ke bbox se) -- poore page se better accuracy aur kam tokens. Multiple images hon to label do ("Image 1: front, Image 2: back").
Production angle: image size/format limits aur per-image token cost provider docs mein check karo, base64 payload bada hota hai (timeouts), aur medical/ID images PII hain -- logs mein raw base64 kabhi mat likho. VLM ka jawab bhi validate karo -- numbers ko OCR/text layer se cross-check karo.

**Try this (20-40 min):** M05 ke FakeLLM pattern se `build_image_message(png_bytes, question)` likho jo upar wala exact block shape banaye; pytest se check karo ki `media_type`, base64 round-trip aur block order (image -> text) sahi hai. Real call sirf tab jab `ANTHROPIC_API_KEY` set ho.

**Read:** https://docs.claude.com/en/docs/build-with-claude/vision

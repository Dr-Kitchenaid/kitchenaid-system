# KitchenAid System Rules

## Project
ระบบร้าน KitchenAid: ใบเสนอราคา, ใบกำกับ, ใบเสร็จ, repair tracking, stock, customer history. Static HTML site บน GitHub Pages, data ใน Cloudflare Worker KV.

## Stack
- Vanilla HTML / CSS / JavaScript (no framework, no build step)
- Cloudflare Worker + KV (backend)
- GitHub Pages (hosting, repo: Dr-Kitchenaid)
- NAS mirror backup

## Deploy
ใช้ skill `ka-deploy` หลังแก้ไฟล์ (commit + push + NAS mirror + KV backup).

## Coding Rules
- Minimal diff. ห้ามรื้อ design language เดิม
- ห้าม redesign section ที่ไม่เกี่ยว
- ใช้ vanilla JS — ห้ามเพิ่ม framework / build tool
- inline `<script>` / `<style>` OK (static site)
- ทุกหน้าเช็ค nav link ครบ (index, customer, repair, quotation, invoice, receipt, inbox, stock, customer-history, settings)

## Data
- KV keys: ดูใน cloudflare-worker/
- Customer key = phone number
- Remote-sync stores ต้องมี `loadedFromRemote` flag กัน wipe (ดู [[feedback_remote_sync_guard]])

## UI / UX
- Thai language
- Mobile-friendly (ร้านใช้บนมือถือ)
- Autocomplete customer phone ทุก form

## Security
- ห้าม commit Cloudflare token / Facebook token / API keys
- ใช้ env / Worker secrets เท่านั้น

## IMPORTANT
- Preserve existing layout + color scheme
- Make minimal safe edits
- ตรวจ skill ka-deploy เสมอ หลังแก้

# 1. เลือก Base Image ที่มี Node.js ติดตั้งอยู่
# ใช้เวอร์ชัน LTS (Long Term Support) และ '-alpine' เพื่อให้ Image มีขนาดเล็ก
FROM node:18-alpine

# 2. ตั้งค่า Working Directory ภายใน Container
# คำสั่งทั้งหมดหลังจากนี้จะทำงานใน path /app
WORKDIR /app

# 3. คัดลอกไฟล์ package.json และ package-lock.json
# การแยกขั้นตอนนี้ออกมาจะช่วยให้ Docker cache layer นี้ไว้ ทำให้ไม่ต้อง install dependencies ใหม่ทุกครั้งที่แก้โค้ด
COPY package*.json ./

# 4. ติดตั้ง Dependencies ทั้งหมดที่ระบุใน package.json
RUN npm install

# 5. คัดลอกไฟล์โค้ดทั้งหมดในโปรเจกต์เข้ามาใน Image
COPY . .

# 6. บอกให้ Docker รู้ว่าแอปพลิเคชันของเราจะทำงานที่ Port 4000
EXPOSE 4000

# 7. คำสั่งที่จะรันเมื่อ Container เริ่มทำงาน
CMD [ "node", "server.js" ]
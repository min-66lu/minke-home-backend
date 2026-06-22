const express = require('express')
const app = express()

app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

app.listen(3000, () => {
  console.log('服务器启动成功，端口 3000')
})
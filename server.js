require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { createClient } = require('@supabase/supabase-js')

const app = express()
app.use(cors())
app.use(express.json())

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

// 健康检查
app.get('/health', (req, res) => res.json({ status: 'ok' }))

// 获取所有会话
app.get('/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions').select('*').order('updated_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// 创建新会话
app.post('/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions').insert({ name: req.body.name || '新对话' }).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// 重命名会话
app.patch('/sessions/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions').update({ name: req.body.name, updated_at: new Date() })
    .eq('id', req.params.id).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// 删除会话
app.delete('/sessions/:id', async (req, res) => {
  const { error } = await supabase.from('sessions').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

// 获取会话消息
app.get('/sessions/:id/messages', async (req, res) => {
  const { data, error } = await supabase
    .from('messages').select('*')
    .eq('session_id', req.params.id).eq('visible', true)
    .order('created_at', { ascending: true })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// 获取设置
app.get('/settings', async (req, res) => {
  const { data, error } = await supabase.from('settings').select('*').single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// 更新设置
app.patch('/settings', async (req, res) => {
  const { data: existing } = await supabase.from('settings').select('id').single()
  const { data, error } = await supabase
    .from('settings').update(req.body).eq('id', existing.id).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// 核心对话接口
app.post('/chat', async (req, res) => {
  const { session_id, message, model = 'claude' } = req.body

  // 保存用户消息
  await supabase.from('messages').insert({
    session_id, role: 'user', content: message
  })

  // 更新会话时间
  await supabase.from('sessions').update({ updated_at: new Date() }).eq('id', session_id)

  // 加载历史消息
  const { data: history } = await supabase
    .from('messages').select('*')
    .eq('session_id', session_id).eq('visible', true)
    .order('created_at', { ascending: true })

  // 加载记忆摘要
  const { data: memories } = await supabase
    .from('memories').select('*').order('created_at', { ascending: false }).limit(1)

  // 加载设置
  const { data: settings } = await supabase.from('settings').select('*').single()

  // 组装系统提示词
  let systemPrompt = settings?.system_prompt || ''
  if (memories && memories.length > 0) {
    systemPrompt += `\n\n以下是你们之前对话的记忆摘要：\n${memories[0].content}`
  }

  // 组装消息历史（最近 context_limit 条）
  const limit = settings?.context_limit || 20
  const recentHistory = history.slice(-limit)
  const messages = recentHistory.map(m => ({ role: m.role, content: m.content }))

  let reply = ''

  try {
    if (model === 'claude') {
      // 调用 Claude API
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: settings?.max_tokens || 1000,
          system: systemPrompt,
          messages
        })
      })
      const data = await response.json()
      reply = data.content?.[0]?.text || '出错了，请重试'
    } else {
      // 调用 DeepSeek API
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          max_tokens: settings?.max_tokens || 1000,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages
          ]
        })
      })
      const data = await response.json()
      console.log('API response:', JSON.stringify(data))
      reply = data.choices?.[0]?.message?.content || '出错了，请重试'
    }
  } catch (e) {
    reply = '请求失败，请检查 API Key 配置'
  }

  // 保存 AI 回复
  await supabase.from('messages').insert({
    session_id, role: 'assistant', content: reply
  })

  // 检查是否需要压缩记忆
  const threshold = settings?.compress_threshold || 15
  if (history.length >= threshold) {
    const toCompress = history.slice(0, history.length - 5)
    const compressText = toCompress.map(m => `${m.role}: ${m.content}`).join('\n')

    try {
      const compressRes = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `请将以下对话压缩成一段简短的中文摘要（200字以内），保留关键信息：\n\n${compressText}`
          }]
        })
      })
      const compressData = await compressRes.json()
      const summary = compressData.choices?.[0]?.message?.content

      if (summary) {
        await supabase.from('memories').insert({ content: summary })
        const ids = toCompress.map(m => m.id)
        await supabase.from('messages').update({ visible: false }).in('id', ids)
      }
    } catch (e) {
      console.log('记忆压缩失败：', e.message)
    }
  }

  res.json({ reply })
})

app.listen(3000, () => console.log('服务器启动成功，端口 3000'))
import { useState, useEffect, useRef, FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import './App.css'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [currentInput, setCurrentInput] = useState('')
  const [currentResponse, setCurrentResponse] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null) // 用于自动滚动
  const [, forceUpdate] = useState(0);

  const backendUrl = 'http://localhost:3001/chat' // 后端 API 地址

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, currentResponse]) // 依赖消息列表和当前响应

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!currentInput.trim() || isLoading) return

    const userMessageContent = currentInput // 保存用户输入，因为 state 会被清空
    const newUserMessage: Message = { role: 'user', content: userMessageContent }
    setMessages((prev) => [...prev, newUserMessage])
    setCurrentInput('')
    setIsLoading(true)
    setCurrentResponse('')

    try {
      // --- 发起 POST 请求，这次我们将直接处理它的响应流 ---
      const response = await fetch(backendUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // SSE 通常需要告知服务器客户端可以接受流
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({ prompt: userMessageContent }), // 使用保存的用户输入
      })

      // 检查响应是否 OK 并且是 SSE 流
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: `HTTP error! status: ${response.status}` }))
        console.error('Error sending message:', response.status, errorData)
        setMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${errorData.message || 'Could not connect'}` }])
        setIsLoading(false)
        return
      }
      if (response.headers.get('Content-Type') !== 'text/event-stream') {
        console.error('Expected text/event-stream, but received:', response.headers.get('Content-Type'))
        setMessages((prev) => [...prev, { role: 'assistant', content: 'Error: Invalid response format from server.' }])
        setIsLoading(false)
        return
      }

      // --- 直接处理 response.body 流 ---
      if (!response.body) {
        throw new Error('Response body is null')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      let accumulatedResponse = '' // 用于累积当前请求的完整响应

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          console.log('Stream finished.')
          break // 跳出循环
        }

        const chunk = decoder.decode(value, { stream: true })
        buffer += chunk

        // 按 SSE 格式处理 buffer 中的数据 (data: ...\n\n)
        const lines = buffer.split('\n\n')
        buffer = lines.pop() || '' // 保留可能不完整的最后一部分

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonData = line.substring(6).trim()
            if (jsonData === '[DONE]') { // 检查 DeepSeek 可能的结束标记
              console.log('Received [DONE] marker.')
              // 可以在这里提前结束，或者依赖下面的 {done: true}
              continue // 继续处理 buffer 中剩余的行
            }
            try {
              const parsedData = JSON.parse(jsonData)

              if (parsedData.done) {
                console.log('Received done:true signal')
                // 流结束信号，不需要再读取
                await reader.cancel() // 主动取消读取器是个好习惯
                // done = true; // 强制退出外部 while 循环 (如果 break 不够)
                break // 跳出内层 for 循环
              } else if (parsedData.chunk) {
                accumulatedResponse += parsedData.chunk
                setCurrentResponse(accumulatedResponse) // 更新界面上的流式响应
                forceUpdate(c => c + 1); // 尝试强制更新
              } else if (parsedData.message && line.startsWith('event: error')) {
                // 处理后端发送的自定义错误事件
                console.error('Received error event from server:', parsedData.message)
                setMessages((prev) => [...prev, { role: 'assistant', content: `Server Error: ${parsedData.message}` }])
                await reader.cancel() // 出错，取消读取
                // done = true; // 强制退出
                break
              }
            } catch (error) {
              console.error('Error parsing SSE data chunk:', jsonData, error)
              // 这里可以选择忽略错误，或者认为流已损坏并停止
              // setMessages((prev) => [...prev, { role: 'assistant', content: 'Error: Corrupted data received.' }]);
              // await reader.cancel();
              // done = true;
              // break;
            }
          } else if (line.startsWith('event: error')) {
            // 处理没有 data: 的错误事件（虽然不太标准）
            console.error('Received raw error event line:', line)
          }
        }
        // 如果内层循环因为 break 退出（如收到 done:true 或错误），也退出外层循环
        if (lines.some(l => l.includes('"done":true') || l.startsWith('event: error'))) {
          break
        }
      } // end while(true)

      // --- 流结束后处理 ---
      // 检查 accumulatedResponse 是否有内容，避免重复添加空消息
      if (accumulatedResponse.trim()) {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: accumulatedResponse },
        ])
      }

    } catch (error) {
      console.error('Error sending message or processing stream:', error)
      setMessages((prev) => [...prev, { role: 'assistant', content: `Failed to get response: ${error instanceof Error ? error.message : String(error)}` }])
    } finally {
      // 确保加载状态结束
      setIsLoading(false)
      setCurrentResponse('') // 清空临时流式响应区域
    }
  }

  return (
    <div className="chat-container">
      <div className="chat-messages">
        {messages.map((msg, index) => (
          <div key={index} className={`message ${msg.role}`}>
            <span className="role">{msg.role === 'user' ? 'You' : 'Assistant'}</span>
            {/* 对已完成的消息使用 ReactMarkdown */}
            <ReactMarkdown>{msg.content}</ReactMarkdown>
          </div>
        ))}

        {/* 显示正在流式传输的响应 - 改为直接渲染文本 */}
        {isLoading && currentResponse && (
          <div className="message assistant">
            <span className="role">Assistant</span>
            {/* 直接渲染 currentResponse 文本，保留换行和空格 */}
            <p style={{ whiteSpace: 'pre-wrap' }}>
              {currentResponse}
              <span className="typing-cursor"></span> {/* 光标可以保留 */}
            </p>
          </div>
        )}

        {/* 空 div 用于滚动定位 */}
        <div ref={messagesEndRef} />
      </div>
      <form onSubmit={handleSubmit} className="chat-input-form">
        <input
          type="text"
          value={currentInput}
          onChange={(e) => setCurrentInput(e.target.value)}
          placeholder="Ask me anything..."
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading}>
          {isLoading ? 'Thinking...' : 'Send'}
        </button>
      </form>
    </div>
  )
}

export default App

import { useState, useEffect, useRef, FormEvent } from "react";
import ReactMarkdown from "react-markdown"; // 用于将 Markdown 文本渲染为 HTML
import "./App.css"; // 引入组件样式

// 定义消息对象的接口，约束消息的结构
interface Message {
  role: "user" | "assistant"; // 消息发送者角色：用户或助手
  content: string; // 消息内容
}

function App() {
  // --- State Hooks ---
  // messages: 存储整个聊天记录（用户和已完成的助手消息）的数组。
  const [messages, setMessages] = useState<Message[]>([]);
  // currentInput: 保存当前用户在输入框中输入的文本。
  const [currentInput, setCurrentInput] = useState("");
  // currentResponse: 用于临时存储 *正在进行中* 的、从后端流式接收到的 AI 回复片段。
  // 这个状态用于在 UI 上实时显示打字效果。
  const [currentResponse, setCurrentResponse] = useState("");
  // isLoading: 布尔值，标记当前是否正在等待后端响应。用于禁用输入框和按钮，并显示加载状态。
  const [isLoading, setIsLoading] = useState(false);
  // messagesEndRef: 一个 Ref 对象，附加到消息列表末尾的空 div 上。
  // 用于在有新消息或流式响应更新时，将聊天窗口滚动到底部。
  const messagesEndRef = useRef<HTMLDivElement>(null); // 用于自动滚动

  // 从环境变量读取后端 URL，如果未设置，则使用默认的本地地址
  const backendUrl =
    import.meta.env.VITE_BACKEND_URL || "http://localhost:3001/chat"; // 新代码 (Vite 方式)

  // --- Effect Hook ---
  // 此 useEffect 负责在 `messages` 数组或 `currentResponse` 字符串更新时，自动将聊天窗口滚动到底部。
  useEffect(() => {
    // `scrollIntoView` 是 DOM API，用于将元素滚动到可视区域。
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); // 使用平滑滚动效果
  }, [messages, currentResponse]); // 依赖项数组：当这些值变化时，effect 将重新运行

  // --- Event Handler ---
  // 处理聊天输入表单提交的异步函数
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault(); // 阻止表单默认的提交行为（页面刷新）

    // 如果当前输入为空或正在加载中，则不执行任何操作
    if (!currentInput.trim() || isLoading) return;

    const userMessageContent = currentInput; // 暂存用户输入，因为 setInput 会清空它
    // 创建新的用户消息对象
    const newUserMessage: Message = {
      role: "user",
      content: userMessageContent,
    };
    // 更新 messages 状态，将新用户消息添加到数组末尾
    // 使用函数式更新，确保基于前一个状态进行更新，避免竞态条件
    setMessages(prev => [...prev, newUserMessage]);
    setCurrentInput(""); // 清空输入框
    setIsLoading(true); // 设置加载状态为 true
    setCurrentResponse(""); // 清空上一次的流式响应临时存储

    try {
      // --- 发起 POST 请求到后端 ---
      const response = await fetch(backendUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json", // 告知服务器请求体是 JSON 格式
          // **关键**: 设置 Accept 头为 'text/event-stream'
          // 这是告知服务器，客户端期望接收 Server-Sent Events (SSE) 流
          Accept: "text/event-stream",
        },
        // 将包含用户输入的 prompt 构造成 JSON 字符串作为请求体
        body: JSON.stringify({ prompt: userMessageContent }),
      });

      // --- 响应状态和类型检查 ---
      // 检查 HTTP 响应状态码是否表示成功 (例如 200 OK)
      if (!response.ok) {
        // 如果状态码不 OK，尝试解析错误信息（假设后端返回 JSON 格式错误）
        const errorData = await response
          .json()
          .catch(() => ({ message: `HTTP error! status: ${response.status}` })); // 如果解析 JSON 失败，则提供通用错误信息
        console.error("Error sending message:", response.status, errorData);
        // 将错误信息作为助手消息添加到聊天记录中
        setMessages(prev => [
          ...prev,
          {
            role: "assistant",
            content: `Error: ${errorData.message || "Could not connect"}`,
          },
        ]);
        setIsLoading(false); // 取消加载状态
        return; // 提前退出函数
      }
      // 检查响应头中的 Content-Type 是否确实是 'text/event-stream'
      if (response.headers.get("Content-Type") !== "text/event-stream") {
        console.error(
          "Expected text/event-stream, but received:",
          response.headers.get("Content-Type")
        );
        // 如果响应类型不符合预期，也显示错误消息
        setMessages(prev => [
          ...prev,
          {
            role: "assistant",
            content: "Error: Invalid response format from server.",
          },
        ]);
        setIsLoading(false); // 取消加载状态
        return; // 提前退出函数
      }

      // --- 处理 SSE 流 ---
      // 确保 response.body (ReadableStream) 存在
      if (!response.body) {
        throw new Error("Response body is null");
      }

      const reader = response.body.getReader(); // 获取流的读取器
      const decoder = new TextDecoder("utf-8"); // 创建 UTF-8 解码器
      let buffer = ""; // 用于缓存可能被分割的 SSE 消息片段
      let accumulatedResponse = ""; // 用于累积当前 Assistant 回复的所有片段

      // 无限循环，持续读取流数据，直到流结束
      while (true) {
        // 读取下一个数据块
        const { done, value } = await reader.read();

        // 如果 done 为 true，表示流已结束
        if (done) {
          console.log("Stream finished.");
          break; // 跳出 while 循环
        }

        // 将接收到的 Uint8Array 数据块解码为字符串
        // { stream: true } 选项允许解码器处理跨块的字符编码
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk; // 将解码后的块追加到缓冲区

        // --- 解析 SSE 消息 ---
        // SSE 消息以 `\n\n` 分隔
        const lines = buffer.split("\n\n");
        // `pop()` 获取并移除数组最后一个元素。如果最后一个元素是不完整的消息，
        // 它会被保留在 buffer 中，等待下一个数据块到来再一起处理。
        buffer = lines.pop() || "";

        // 遍历完整接收到的 SSE 消息行
        for (const line of lines) {
          // SSE 数据消息通常以 "data: " 开头
          if (line.startsWith("data: ")) {
            // 提取 "data: " 后面的 JSON 字符串
            const jsonData = line.substring(6).trim();

            // 检查是否是 DeepSeek 特有的流结束标记 "[DONE]"
            if (jsonData === "[DONE]") {
              console.log("Received [DONE] marker.");
              continue; // 继续处理 buffer 中可能存在的其他行
            }

            try {
              // 尝试解析 JSON 数据
              const parsedData = JSON.parse(jsonData);

              // 检查是否是自定义的结束信号 { done: true }
              if (parsedData.done) {
                console.log("Received done:true signal from backend.");
                // 如果收到明确的结束信号，可以提前取消读取器，停止接收
                await reader.cancel(); // 主动取消是个好习惯
                break; // 跳出内层 for 循环 (处理当前批次行的循环)
              }
              // 检查是否是包含文本块的数据 { chunk: "..." }
              else if (parsedData.chunk) {
                // 将接收到的文本块追加到累积响应中
                accumulatedResponse += parsedData.chunk;
                // 更新 currentResponse 状态，使 UI 实时显示新增文本
                setCurrentResponse(accumulatedResponse);
              }
              // 检查是否是后端发送的自定义错误事件
              else if (
                parsedData.message &&
                line.startsWith("event: error") // 结合 event 类型判断
              ) {
                console.error(
                  "Received error event from server:",
                  parsedData.message
                );
                // 将服务器错误信息显示给用户
                setMessages(prev => [
                  ...prev,
                  {
                    role: "assistant",
                    content: `Server Error: ${parsedData.message}`,
                  },
                ]);
                await reader.cancel(); // 出错，取消读取
                break; // 跳出内层 for 循环
              }
            } catch (error) {
              // 处理 JSON 解析错误
              console.error("Error parsing SSE data chunk:", jsonData, error);
              // 根据需要决定如何处理：可以忽略、显示错误、或终止流处理
              // 例如:
              // setMessages((prev) => [...prev, { role: 'assistant', content: 'Error: Corrupted data received.' }]);
              // await reader.cancel();
              // break; // 也可以在这里跳出内层循环
            }
          } else if (line.startsWith("event: error")) {
            // 处理不带 "data: " 的错误事件（虽然不太标准，但作为健壮性处理）
            console.error("Received raw error event line:", line);
          }
        } // 内层 for 循环结束

        // --- 检查是否需要退出外层循环，下面是外层循环的控制结束的条件 ---
        // 如果内层循环是因为收到了 `done: true` 或错误事件而 `break` 的，
        // 那么我们也应该退出外层的 `while(true)` 循环。
        // 这里通过检查 lines 数组中是否包含特定的标记来实现。
        // 注意：这个检查逻辑依赖于内层 break 时 lines 数组的状态，可能需要根据实际情况调整。
        // 一个更可靠的方法可能是在内层 break 时设置一个标志位。
        if (
          lines.some(
            l => l.includes('"done":true') || l.startsWith("event: error")
          )
        ) {
          break; // 跳出外层 while 循环
        }
      } // end while(true) - 流读取循环结束

      // --- 流结束后处理 ---
      // 当流完全处理完毕 (while 循环结束)
      // 检查累积的响应内容是否为空，避免添加一个空的助手消息
      if (accumulatedResponse.trim()) {
        // 将累积的完整响应作为一个新的助手消息添加到 messages 状态中
        setMessages(prev => [
          ...prev,
          { role: "assistant", content: accumulatedResponse },
        ]);
      }
    } catch (error) {
      // 捕获 fetch 调用、流处理过程中的任何未捕获错误
      console.error("Error sending message or processing stream:", error);
      // 将错误信息作为助手消息显示给用户
      setMessages(prev => [
        ...prev,
        {
          role: "assistant",
          content: `Failed to get response: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ]);
    } finally {
      // --- 清理工作 ---
      // 不论成功还是失败，finally 块总会执行
      setIsLoading(false); // 确保加载状态被重置为 false
      setCurrentResponse(""); // 清空临时流式响应区域
    }
  };

  // --- JSX 渲染 ---
  return (
    <div className="chat-container">
      {" "}
      {/* 主容器 */}
      <div className="chat-messages">
        {" "}
        {/* 消息显示区域 */}
        {/* 遍历 messages 数组，为每条消息渲染一个 div */}
        {messages.map((msg, index) => (
          <div key={index} className={`message ${msg.role}`}>
            {" "}
            {/* 根据角色应用不同样式 */}
            {/* 显示角色名称 */}
            <span className="role">
              {msg.role === "user" ? "You" : "Assistant"}
            </span>
            {/* **关键**: 使用 ReactMarkdown 将消息内容从 Markdown 格式渲染为 HTML */}
            {/* 这允许 AI 的响应包含格式化文本、列表、代码块等 */}
            <ReactMarkdown>{msg.content}</ReactMarkdown>
          </div>
        ))}
        {/* **关键**: 条件渲染正在流式传输的响应 */}
        {/* 仅当 isLoading 为 true 且 currentResponse 有内容时显示 */}
        {isLoading && currentResponse && (
          <div className="message assistant">
            {" "}
            {/* 应用助手消息样式 */}
            <span className="role">Assistant</span>
            {/* 直接渲染 currentResponse 文本内容 */}
            {/* 使用 `whiteSpace: "pre-wrap"` CSS 样式保留文本中的换行符和空格 */}
            <p style={{ whiteSpace: "pre-wrap" }}>
              {currentResponse}
              {/* 可以添加一个视觉元素模拟打字光标 */}
              <span className="typing-cursor"></span>
            </p>
          </div>
        )}
        {/* 空 div，用于 `messagesEndRef` 附加，实现自动滚动 */}
        <div ref={messagesEndRef} />
      </div>
      {/* 聊天输入表单 */}
      <form onSubmit={handleSubmit} className="chat-input-form">
        <input
          type="text"
          value={currentInput} // 输入框的值受 currentInput 状态控制
          onChange={e => setCurrentInput(e.target.value)} // 输入变化时更新状态
          placeholder="Ask me anything..." // 提示文字
          disabled={isLoading} // 当 isLoading 为 true 时禁用输入框
        />
        <button type="submit" disabled={isLoading}>
          {" "}
          {/* 当 isLoading 为 true 时禁用按钮 */}
          {isLoading ? "Thinking..." : "Send"}{" "}
          {/* 根据加载状态显示不同按钮文本 */}
        </button>
      </form>
    </div>
  );
}

export default App; // 导出 App 组件

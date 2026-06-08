import { logError } from "../logger/index.js";
import { STREAMING_CHUNK_DELAY } from "../config.js";
import { sendMessage } from "./chat.js";

// ─── OpenAI Tool Response Builder ─────────────────────────────────────────────

export function buildOpenAIToolResponse(result, mappedModel, toolCalls) {
	return {
		id: result.id || "chatcmpl-" + Date.now(),
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: result.model || mappedModel || "qwen-max-latest",
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: null,
					tool_calls: toolCalls.map(({ index, ...call }) => call),
				},
				finish_reason: "tool_calls",
			},
		],
		usage: result.usage || {
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
		},
		chatId: result.chatId,
		parentId: result.parentId || result.response_id,
		x_qwen_chat_id: result.chatId,
		x_qwen_parent_id: result.parentId || result.response_id,
	};
}

// ─── SSE Helpers ──────────────────────────────────────────────────────────────

export function writeToolCallsSse(res, mappedModel, result, toolCalls) {
	const base = {
		id: result.id || "chatcmpl-stream",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: result.model || mappedModel || "qwen-max-latest",
	};
	res.write(
		"data: " +
			JSON.stringify({
				...base,
				choices: [
					{ index: 0, delta: { role: "assistant" }, finish_reason: null },
				],
			}) +
			"\n\n",
	);
	for (const call of toolCalls) {
		res.write(
			"data: " +
				JSON.stringify({
					...base,
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: call.index,
										id: call.id,
										type: "function",
										function: call.function,
									},
								],
							},
							finish_reason: null,
						},
					],
				}) +
				"\n\n",
		);
	}
	res.write(
		"data: " +
			JSON.stringify({
				...base,
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			}) +
			"\n\n",
	);
	res.write("data: [DONE]\n\n");
	res.end();
}

// ─── Streaming Handler (for simple /chat endpoint) ────────────────────────────

export async function handleStreamingResponse(
	res,
	mappedModel,
	messageContent,
	chatId,
	parentId,
	combinedTools,
	toolChoice,
	systemMessage,
) {
	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");

	const writeSse = (payload) =>
		res.write("data: " + JSON.stringify(payload) + "\n\n");

	writeSse({
		id: "chatcmpl-stream",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: mappedModel,
		choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
	});

	try {
		const result = await sendMessage(
			messageContent,
			mappedModel,
			chatId,
			parentId,
			null,
			combinedTools,
			toolChoice,
			systemMessage,
		);

		if (result.error) {
			writeSse({
				id: "chatcmpl-stream",
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: mappedModel,
				choices: [
					{
						index: 0,
						delta: { content: `Ошибка: ${result.error}` },
						finish_reason: null,
					},
				],
			});
		} else if (result.choices?.[0]?.message) {
			const content = String(result.choices[0].message.content || "");
			const codePoints = Array.from(content);
			const chunkSize = 16;
			for (let i = 0; i < codePoints.length; i += chunkSize) {
				writeSse({
					id: "chatcmpl-stream",
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: mappedModel,
					choices: [
						{
							index: 0,
							delta: { content: codePoints.slice(i, i + chunkSize).join("") },
							finish_reason: null,
						},
					],
				});
				await new Promise((r) => setTimeout(r, STREAMING_CHUNK_DELAY));
			}
		}

		writeSse({
			id: "chatcmpl-stream",
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: mappedModel,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		});
		res.write("data: [DONE]\n\n");
		res.end();
	} catch (error) {
		logError("Ошибка при обработке потокового запроса", error);
		writeSse({
			id: "chatcmpl-stream",
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: mappedModel,
			choices: [
				{
					index: 0,
					delta: { content: "Internal server error" },
					finish_reason: "stop",
				},
			],
		});
		res.write("data: [DONE]\n\n");
		res.end();
	}
}

// ─── Non-streaming Response Handler ───────────────────────────────────────────

export function handleNonStreamingResponse(res, result, mappedModel) {
	if (result.error) {
		return res.status(500).json({
			error: { message: result.error, type: "server_error" },
		});
	}

	res.json({
		id: result.id || "chatcmpl-" + Date.now(),
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: result.model || mappedModel,
		choices: result.choices || [
			{
				index: 0,
				message: { role: "assistant", content: "" },
				finish_reason: "stop",
			},
		],
		usage: result.usage || {
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
		},
		chatId: result.chatId,
		parentId: result.parentId,
	});
}

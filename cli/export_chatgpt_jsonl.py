#!/usr/bin/env python3
"""
ChatGPT Rich Exporter & Cleaner to JSONL
Transforms ChatGPT raw conversation dumps, step files, or official export (conversations.json)
into clean, rich agent datasets (prompts, agent responses, tool calls, tool responses, thoughts, citations).
"""

import json
import sys
import os
from typing import Dict, Any, List, Optional


def extract_text_from_content(content_obj: Dict[str, Any]) -> str:
    """Extract string text from ChatGPT content object (text, parts, code, multimodal)."""
    if not isinstance(content_obj, dict):
        return str(content_obj) if content_obj is not None else ""

    parts = content_obj.get("parts")
    if parts and isinstance(parts, list):
        out = []
        for p in parts:
            if isinstance(p, str):
                out.append(p)
            elif isinstance(p, dict):
                if "text" in p:
                    out.append(p["text"])
                elif "content" in p:
                    out.append(str(p["content"]))
                else:
                    out.append(json.dumps(p, ensure_ascii=False))
            else:
                out.append(str(p))
        return "\n".join(out)

    if "text" in content_obj:
        return str(content_obj["text"])

    return ""


def clean_conversation_nodes(path_nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Clean linear path nodes into proper agent messages with thoughts and real tool calls."""
    messages = []
    current_thought = []
    last_assistant_call_id = None

    for node in path_nodes:
        author = node.get("author", {})
        role = author.get("role", "unknown")
        content_obj = node.get("content", {})
        metadata = node.get("metadata", {})
        recipient = node.get("recipient")
        content_type = content_obj.get("content_type")

        # Capture thoughts from reasoning nodes
        if content_type in ("thoughts", "reasoning_recap"):
            for t in content_obj.get("thoughts", []):
                if isinstance(t, dict):
                    text_t = t.get("content") or t.get("summary") or ""
                    if text_t:
                        current_thought.append(text_t)
                elif isinstance(t, str):
                    current_thought.append(t)
            if content_obj.get("content"):
                current_thought.append(str(content_obj.get("content")))
            continue

        text = extract_text_from_content(content_obj)

        # In ChatGPT, recipient == 'all' means broadcast to human, NOT a tool call
        is_tool_call = bool(recipient and recipient != "all") or (content_type == "code" and role == "assistant")

        if not text and not is_tool_call and role != "tool":
            continue

        if role == "user":
            u_msg = {
                "role": "user",
                "content": text,
                "created_at": node.get("create_time")
            }
            if metadata.get("attachments"):
                u_msg["attachments"] = metadata["attachments"]
            messages.append(u_msg)
            current_thought = []
            last_assistant_call_id = None

        elif role == "assistant":
            if is_tool_call:
                tool_name = recipient if (recipient and recipient != "all") else "python"
                call_id = f"call_{node.get('id', '')[:16]}"
                last_assistant_call_id = call_id

                args = {}
                if content_type == "code":
                    args = {"code": text}
                else:
                    try:
                        args = json.loads(text)
                    except Exception:
                        args = {"input": text}

                asst_msg = {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": tool_name,
                            "arguments": json.dumps(args, ensure_ascii=False)
                        }
                    }],
                    "created_at": node.get("create_time"),
                    "message_id": node.get("id")
                }
                if current_thought:
                    asst_msg["thought"] = "\n".join(current_thought)
                    current_thought = []
                messages.append(asst_msg)
            else:
                asst_msg = {
                    "role": "assistant",
                    "content": text,
                    "created_at": node.get("create_time"),
                    "message_id": node.get("id")
                }
                if current_thought:
                    asst_msg["thought"] = "\n".join(current_thought)
                    current_thought = []
                if metadata.get("citations"):
                    asst_msg["citations"] = metadata["citations"]
                messages.append(asst_msg)
                last_assistant_call_id = None

        elif role == "tool":
            tool_name = author.get("name") or "tool"
            tool_call_id = last_assistant_call_id or f"call_{node.get('id', '')[:16]}"
            messages.append({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "name": tool_name,
                "content": text if text else json.dumps(content_obj, ensure_ascii=False),
                "created_at": node.get("create_time")
            })

    return messages


def transform_raw_mapping(conv_data: Dict[str, Any]) -> Dict[str, Any]:
    conv_id = conv_data.get("id") or conv_data.get("conversation_id") or "unknown_id"
    title = conv_data.get("title") or "Untitled Conversation"
    mapping = conv_data.get("mapping", {})

    leaves = [nid for nid, n in mapping.items() if not n.get("children")]
    current_node = conv_data.get("current_node") or (leaves[-1] if leaves else list(mapping.keys())[-1])

    path = []
    curr = current_node
    visited = set()
    while curr and curr in mapping and curr not in visited:
        visited.add(curr)
        node = mapping[curr]
        if node.get("message"):
            path.append({"node_id": curr, **node["message"]})
        curr = node.get("parent")
    path.reverse()

    messages = clean_conversation_nodes(path)

    return {
        "id": conv_id,
        "title": title,
        "total_messages": len(messages),
        "messages": messages
    }


def clean_steps_file(steps_file_path: str) -> Dict[str, Any]:
    steps = []
    with open(steps_file_path, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                steps.append(json.loads(line))

    if not steps:
        return {}

    conv_id = steps[0].get("conversation_id") or "unknown"
    title = steps[0].get("title") or "Untitled"

    cleaned_messages = []
    current_thought = []

    for step in steps:
        role = step.get("role")
        content = step.get("content")
        tool_calls = step.get("tool_calls")

        # Strip fake 'all' tool calls
        if tool_calls and len(tool_calls) == 1 and tool_calls[0].get("function", {}).get("name") == "all":
            tool_calls = None
            if not content:
                if step.get("thought"):
                    current_thought.append(step.get("thought"))
                continue

        if role == "assistant":
            asst_msg = {
                "role": "assistant",
                "content": content,
                "created_at": step.get("created_at")
            }
            if tool_calls:
                asst_msg["tool_calls"] = tool_calls
            if current_thought:
                asst_msg["thought"] = "\n".join(current_thought)
                current_thought = []
            elif step.get("thought"):
                asst_msg["thought"] = step.get("thought")
            cleaned_messages.append(asst_msg)

        elif role == "user":
            u_msg = {
                "role": "user",
                "content": content,
                "created_at": step.get("created_at")
            }
            if step.get("attachments"):
                u_msg["attachments"] = step.get("attachments")
            cleaned_messages.append(u_msg)
            current_thought = []

        elif role == "tool":
            cleaned_messages.append({
                "role": "tool",
                "tool_call_id": step.get("tool_call_id"),
                "name": step.get("name"),
                "content": content,
                "created_at": step.get("created_at")
            })

    return {
        "id": conv_id,
        "title": title,
        "total_messages": len(cleaned_messages),
        "messages": cleaned_messages
    }


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/export_chatgpt_jsonl.py <input.json | input_steps.jsonl> [output.jsonl]")
        sys.exit(1)

    in_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else in_path.replace(".json", "_clean.jsonl").replace(".jsonl", "_clean.jsonl")

    if in_path.endswith("_steps.jsonl") or in_path.endswith("steps.jsonl"):
        result = clean_steps_file(in_path)
    else:
        with open(in_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        result = transform_raw_mapping(data)

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(result, ensure_ascii=False) + "\n")

    print(f"✅ Cleaned and exported {result['total_messages']} messages to: {out_path}")


if __name__ == "__main__":
    main()

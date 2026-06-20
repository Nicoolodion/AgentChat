import type { ChatCompletionTool } from "openai/resources/chat/completions/completions";

export const AGENT_TOOL_SCHEMAS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "file_read",
      description: "Read content of a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path within workspace" },
          encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_write",
      description: "Write content to a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path within workspace" },
          content: { type: "string" },
          encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_list",
      description: "List files in a workspace directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", default: "/", description: "Directory path relative to workspace" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_delete",
      description: "Delete a file or directory in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_move",
      description: "Move or rename a file within the workspace.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source path relative to workspace" },
          destination: { type: "string", description: "Destination path relative to workspace" },
        },
        required: ["source", "destination"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_info",
      description: "Get file metadata (size, mime type, modified time).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ipython",
      description: "Execute Python code with persistent session state. Matplotlib, Pillow, pandas, numpy, opencv, openpyxl, python-docx, pikepdf are available.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "Python code to execute" },
          timeout: { type: "number", default: 60, description: "Max execution time in seconds" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell",
      description: "Execute a shell command in the workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command" },
          working_dir: { type: "string", default: "/", description: "Working directory relative to workspace" },
          timeout: { type: "number", default: 30 },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pip_install",
      description: "Install a Python package via pip in the sandbox.",
      parameters: {
        type: "object",
        properties: {
          package: { type: "string", description: "Package name (e.g. 'openpyxl', 'requests')" },
        },
        required: ["package"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pdf_from_html",
      description: "Convert an HTML file to PDF using Playwright + Paged.js.",
      parameters: {
        type: "object",
        properties: {
          html_path: { type: "string", description: "Relative path to HTML file" },
          output_path: { type: "string", description: "Relative path for output PDF" },
        },
        required: ["html_path", "output_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docx_to_pdf",
      description: "Convert a DOCX file to PDF using LibreOffice.",
      parameters: {
        type: "object",
        properties: {
          input_path: { type: "string" },
          output_path: { type: "string" },
        },
        required: ["input_path", "output_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docx_read",
      description: "Read and parse a .docx file, returning structured content (paragraphs with styles, tables, images). Use this instead of ipython or file_read for .docx files. Returns a text_summary plus structured data.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the .docx file (e.g. 'upload/template.docx')" },
          include_images: { type: "boolean", default: true, description: "Whether to include image metadata" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docx_template_fill",
      description: "Fill a .docx template with new content while preserving the template's cover page, tables, headers/footers, and styles. IMPORTANT for complex sections with many images: first write the JSON sections array to a file (e.g. 'temp/sections.json') using file_write, then pass sections_path. This avoids JSON parsing failures with large arguments.",
      parameters: {
        type: "object",
        properties: {
          template_path: { type: "string", description: "Path to the template .docx file (e.g. 'upload/Musterprotokoll.docx')" },
          output_path: { type: "string", description: "Output path for the new document (e.g. 'output/Protokoll.docx')" },
          sections: {
            type: "array",
            description: "Content sections to add after the cover page. For large/complex sections, use sections_path instead.",
            items: {
              type: "object",
              properties: {
                heading: { type: "string", description: "Section heading text" },
                heading_level: { type: "number", description: "Heading level (1-4, default 1)", default: 1 },
                content: { type: "string", description: "Section body content (supports **bold**, *italic*, - bullets, 1. numbered lists, ### sub-headings)" },
                images: {
                  type: "array",
                  description: "Images to insert in this section",
                  items: {
                    type: "object",
                    properties: {
                      path: { type: "string", description: "Relative path to image file" },
                      caption: { type: "string", description: "Optional caption below the image" },
                      width: { type: "number", description: "Width in inches (default 5.0)", default: 5.0 },
                    },
                    required: ["path"],
                  },
                },
              },
              required: ["heading"],
            },
          },
          sections_path: { type: "string", description: "Path to a JSON file containing the sections array (written via file_write). Preferred over inline sections for complex documents with many images." },
          keep_cover_page: { type: "boolean", default: true, description: "Preserve the template's cover page (first tables before any heading)" },
          cover_replacements: {
            type: "object",
            description: "Text replacements on the cover page: {search_text: replacement_text}",
            additionalProperties: { type: "string" },
          },
        },
        required: ["template_path", "output_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docx_create",
      description: "Create a Word document using python-docx. The working directory is already set to your session workspace. Use RELATIVE paths (e.g. 'output/file.docx'). The output/ directory exists. You can also use the WORKSPACE_DIR variable for absolute paths.",
      parameters: {
        type: "object",
        properties: {
          output_path: { type: "string", description: "Relative path for output DOCX (e.g. 'output/report.docx')" },
          python_code: { type: "string", description: "Python code using python-docx to build the document. Use relative paths or WORKSPACE_DIR for absolute paths." },
        },
        required: ["output_path", "python_code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docx_build",
      description: "Build a high-quality Word document using the DOCX skill's C# + OpenXML SDK pipeline. IMPORTANT: First write your Program.cs using file_write to a path like 'temp/Program.cs', then provide that path in program_cs_path. This avoids JSON escaping issues with inline code. Only use program_cs for very short snippets.",
      parameters: {
        type: "object",
        properties: {
          output_path: { type: "string", description: "Relative path for output DOCX (e.g. 'output/report.docx')" },
          program_cs_path: { type: "string", description: "Relative path to the C# source file previously written via file_write (e.g. 'temp/Program.cs'). Preferred over program_cs." },
          program_cs: { type: "string", description: "C# source code string (fallback — prefer program_cs_path to avoid escaping issues)." },
        },
        required: ["output_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "xlsx_create",
      description: "Create an Excel spreadsheet using openpyxl. The working directory is already set to your session workspace. Use RELATIVE paths (e.g. 'output/file.xlsx'). The output/ directory exists. You can also use the WORKSPACE_DIR variable for absolute paths.",
      parameters: {
        type: "object",
        properties: {
          output_path: { type: "string", description: "Relative path for output XLSX (e.g. 'output/data.xlsx')" },
          python_code: { type: "string", description: "Python code using openpyxl to build the spreadsheet. Use relative paths or WORKSPACE_DIR for absolute paths." },
        },
        required: ["output_path", "python_code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pptx_create",
      description: "Create a PowerPoint presentation using python-pptx. The working directory is already set to your session workspace. Use RELATIVE paths (e.g. 'output/file.pptx'). The output/ directory exists. You can also use the WORKSPACE_DIR variable for absolute paths.",
      parameters: {
        type: "object",
        properties: {
          output_path: { type: "string", description: "Relative path for output PPTX (e.g. 'output/slides.pptx')" },
          python_code: { type: "string", description: "Python code using python-pptx to build the presentation. Use relative paths or WORKSPACE_DIR for absolute paths." },
        },
        required: ["output_path", "python_code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "libreoffice_convert",
      description: "Convert between office formats using LibreOffice (e.g. docx to pdf, pptx to pdf, etc).",
      parameters: {
        type: "object",
        properties: {
          input_path: { type: "string" },
          output_format: { type: "string", description: "Target format extension e.g. 'pdf', 'docx', 'html'" },
          output_path: { type: "string" },
        },
        required: ["input_path", "output_format"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web. Returns a list of search results with title, URL, and snippet. Returns an explicit error field when no results are found.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          max_results: { type: "number", default: 5, description: "Maximum number of results (1-10)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a URL and return its content as text, HTML, or markdown.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          format: { type: "string", enum: ["html", "text", "markdown"], default: "text" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "chart_create",
      description: "Create a chart using matplotlib and save it as an image. The working directory is already set to your session workspace. Use RELATIVE paths (e.g. 'output/chart.png'). The output/ directory exists. You can also use the WORKSPACE_DIR variable for absolute paths.",
      parameters: {
        type: "object",
        properties: {
          python_code: { type: "string", description: "Python code using matplotlib to create the chart. Use relative paths or WORKSPACE_DIR for absolute paths." },
          output_path: { type: "string", description: "Relative path for output image (e.g. output/chart.png)" },
        },
        required: ["python_code", "output_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "image_analyze",
      description: "Analyze one or more image files using the vision-capable model. Returns an array of descriptions, one per image, in the same order as the input paths. The tool is batched automatically, so you can pass many paths at once.",
      parameters: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, description: "Relative paths to the image files in the workspace (e.g. ['upload/photo1.jpg', 'upload/photo2.png'])." },
          prompt: { type: "string", description: "What to ask about each image. Default: 'Describe this image concisely.'", default: "Describe this image concisely." },
          detail: { type: "string", enum: ["high", "low"], description: "Vision detail level. Use 'low' for a faster, cheaper overview. Default: 'high'", default: "high" },
        },
        required: ["paths"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_create",
      description: "Create a todo list in the workspace for tracking progress.",
      parameters: {
        type: "object",
        properties: {
          items: { type: "array", items: { type: "string" }, description: "List of todo items" },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_read",
      description: "Read the current todo list from the workspace.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

export const SKILL_EXTENSIONS: Record<string, string> = {
  ".docx": "docx",
  ".doc": "docx",
  ".pdf": "pdf",
};

const AGENT_SYSTEM_PROMPT_BASE = `You are the Chatinterface Agent — an autonomous reasoning engine that helps users create documents, analyze files, write code, search the web, and perform multi-step tasks.

## Workspace
You have a persistent workspace. The current working directory is already set to your session workspace directory which contains:
- upload/ — user uploaded files
- output/ — generated artifacts (place final deliverables here)
- temp/ — scratch space

IMPORTANT: Use RELATIVE paths in your Python code (e.g. 'output/report.docx', 'temp/data.csv'). The working directory is already set to your workspace root. If you need the absolute path, use the WORKSPACE_DIR environment variable.

## ReAct Loop
Think step-by-step. When you need to act, use a tool. After receiving tool results, decide the next step. Always explain your reasoning.

## Available Tools
### File I/O
- file_read(path, encoding?) — read a file
- file_write(path, content, encoding?) — write a file
- file_list(path?) — list directory contents
- file_delete(path) — delete a file
- file_move(source, destination) — move/rename a file
- file_info(path) — get file metadata

### Code Execution
- ipython(code, timeout?) — execute Python with persistent session state (matplotlib, Pillow, pandas, numpy, opencv, openpyxl, python-docx, pikepdf available)
- shell(command, working_dir?, timeout?) — run shell commands
- pip_install(package) — install a Python package

### Document Generation
- pdf_from_html(html_path, output_path) — convert HTML to PDF via Playwright
- docx_to_pdf(input_path, output_path) — convert DOCX to PDF via LibreOffice
- docx_read(path) — read and parse a .docx file (returns structured content: paragraphs, tables, images). Use this instead of file_read for .docx files.
- docx_template_fill(template_path, output_path, sections?, sections_path?, keep_cover_page?, cover_replacements?) — fill a .docx template with new content. For complex sections with many images, write the sections JSON to a file first and use sections_path to avoid JSON parsing failures.
- docx_create(output_path, python_code) — create Word doc using python-docx
- docx_build(output_path, program_cs_path?, program_cs?) — build high-quality Word doc using C# + OpenXML SDK. IMPORTANT: write Program.cs via file_write first, then pass the path in program_cs_path.
- xlsx_create(output_path, python_code) — create Excel sheet using openpyxl
- pptx_create(output_path, python_code) — create PowerPoint using python-pptx
- libreoffice_convert(input_path, output_format, output_path?) — convert office formats

### Web & Search
- web_search(query, max_results?) — search the web (SearXNG or DuckDuckGo)
- web_fetch(url, format?) — fetch a webpage (html, text, markdown)

### Charts & Images
- chart_create(python_code, output_path) — create matplotlib chart
- image_analyze(paths, prompt?, detail?) — analyze multiple images in one call. Pass all relevant image paths together; the tool batches them automatically.

### Project Management
- todo_create(items) — create a todo list
- todo_read() — read current todo list

## Skills
Skills are mounted at /app/skills/ and provide domain expertise for document generation tasks. The relevant SKILL.md content for your task is automatically injected below when applicable.
- /app/skills/docx/ — Word documents (C# + OpenXML SDK creation, WIR editing)
- /app/skills/pdf/ — PDF generation from HTML

If you need a skill not included below, use file_read with the path /app/skills/<skill>/SKILL.md.

## Quality Standards
- Place all final deliverables in the output/ directory.
- Use clear, descriptive filenames.
- Summarize what you produced in your final message.
- If a step fails, retry with a different approach or ask the user.
- For document generation, the relevant SKILL.md has been included — follow its routing rules and quality standards.`;

export function buildSystemPrompt(skillContent?: Map<string, string>): string {
  let prompt = AGENT_SYSTEM_PROMPT_BASE;

  prompt += `\n\nCurrent date/time: ${new Date().toISOString()}`;

  if (skillContent && skillContent.size > 0) {
    const sections: string[] = [];
    for (const [skillName, content] of skillContent) {
      sections.push(`## Skill: ${skillName}\n\n${content}`);
    }
    prompt += `\n\n---\n\n# Auto-Loaded Skill Instructions\n\nThe following skill instructions were automatically loaded based on the files in the upload/ directory. Follow these rules without needing to read them again:\n\n${sections.join("\n\n")}`;
  }

  return prompt;
}

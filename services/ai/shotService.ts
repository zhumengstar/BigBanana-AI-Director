/**
 * 分镜辅助服务
 * 包含关键帧优化、动作生成、镜头拆分、九宫格分镜等功能
 */

import {
  AspectRatio,
  NineGridPanel,
  PromptTemplateConfig,
  StoryboardGridPanelCount,
} from "../../types";
import { addRenderLogWithTokens } from '../renderLogService';
import {
  retryOperation,
  cleanJsonString,
  chatCompletion,
  getActiveChatModel,
} from './apiCore';
import { getStylePromptCN, getStylePrompt } from './promptConstants';
import { generateImage } from './visualService';
import {
  NINE_GRID_SPLIT_PROMPT,
  NINE_GRID_IMAGE_PROMPT_TEMPLATE,
  resolveStoryboardGridLayout,
} from './storyboardPromptTemplates';
import {
  DEFAULT_PROMPT_TEMPLATE_CONFIG,
  renderPromptTemplate,
  resolvePromptTemplateConfig,
  withTemplateFallback,
} from '../promptTemplateService';

const countEnglishWords = (text: string): number => {
  const matches = String(text || '').trim().match(/[A-Za-z0-9'-]+/g);
  return matches ? matches.length : 0;
};

// ============================================
// 关键帧优化
// ============================================

/**
 * AI一次性优化起始帧和结束帧视觉描述（推荐使用）
 */
export const optimizeBothKeyframes = async (
  actionSummary: string,
  cameraMovement: string,
  sceneInfo: { location: string; time: string; atmosphere: string },
  characterInfo: string[],
  visualStyle: string,
  model: string = ''
): Promise<{ startPrompt: string; endPrompt: string }> => {
  console.log('🎨 optimizeBothKeyframes 调用 - 同时优化起始帧和结束帧 - 使用模型:', model);
  const startTime = Date.now();

  const styleDesc = getStylePromptCN(visualStyle);

  const prompt = `
你是一位专业的电影视觉导演和概念艺术家。请为以下镜头同时创作起始帧和结束帧的详细视觉描述。

## 场景信息
**地点：** ${sceneInfo.location}
**时间：** ${sceneInfo.time}
**氛围：** ${sceneInfo.atmosphere}

## 叙事动作
${actionSummary}

## 镜头运动
${cameraMovement}

## 角色信息
${characterInfo.length > 0 ? characterInfo.join('、') : '无特定角色'}

## 视觉风格
${styleDesc}

## 任务要求

你需要为这个8-10秒的镜头创作**起始帧**和**结束帧**两个关键画面的视觉描述。

### 起始帧要求：
• 建立清晰的初始场景和人物状态
• 为即将发生的动作预留视觉空间和动势
• 设定光影和色调基调
• 展现角色的起始表情、姿态和位置
• 根据镜头运动（${cameraMovement}）设置合适的初始构图
• 营造场景氛围，让观众明确故事的起点

### 结束帧要求：
• 展现动作完成后的最终状态和结果
• 体现镜头运动（${cameraMovement}）带来的视角和构图变化
• 展现角色的情绪变化、最终姿态和位置
• 可以有戏剧性的光影和色彩变化
• 达到视觉高潮或情绪释放点
• 为下一个镜头的衔接做准备

### 两帧协调性：
⚠️ **关键**：起始帧和结束帧必须在视觉上连贯协调
- 保持一致的视觉风格和色调基础
- 镜头运动轨迹要清晰可推导
- 人物/物体的空间位置变化要合理
- 光影变化要有逻辑性
- 两帧描述应该能够自然串联成一个流畅的视觉叙事

### 每帧必须包含的视觉元素：

**1. 构图与景别**
- 根据镜头运动确定画面框架和视角
- 主体在画面中的位置和大小
- 前景、中景、背景的层次关系

**2. 光影与色彩**
- 光源的方向、强度和色温
- 主光、辅光、轮廓光的配置
- 整体色调和色彩情绪（暖色/冷色）
- 阴影的长度和密度

**3. 角色细节**（如有）
- 面部表情和眼神方向
- 肢体姿态和重心分布
- 服装状态和细节
- 与环境的互动关系

**4. 环境细节**
- 场景的具体视觉元素
- 环境氛围（雾气、光束、粒子等）
- 背景的清晰度和景深效果
- 环境对叙事的支持

**5. 运动暗示**
- 动态模糊或静止清晰
- 运动方向的视觉引导
- 张力和动势的体现

**6. 电影感细节**
- 画面质感和材质
- 大气透视效果
- 电影级的视觉特征

## 输出格式

请按以下JSON格式输出（注意：描述文本用中文，每个约100-150字）：

\`\`\`json
{
  "startFrame": "起始帧的详细视觉描述...",
  "endFrame": "结束帧的详细视觉描述..."
}
\`\`\`

❌ 避免：
- 不要在描述中包含"Visual Style:"等标签
- 不要分段或使用项目符号
- 不要过于技术化的术语
- 不要描述整个动作过程，只描述画面本身

✅ 追求：
- 流畅的单段描述
- 富有画面感的语言
- 两帧描述相互呼应、逻辑连贯
- 与叙事动作和镜头运动协调一致
- 具体、可视觉化的细节

请开始创作：
`;

  try {
    const result = await retryOperation(() => chatCompletion(prompt, model, 0.7, 2048, 'json_object'));
    const duration = Date.now() - startTime;

    const cleaned = cleanJsonString(result);
    const parsed = JSON.parse(cleaned);

    if (!parsed.startFrame || !parsed.endFrame) {
      throw new Error('AI返回的JSON格式不正确');
    }

    console.log('✅ AI同时优化起始帧和结束帧成功，耗时:', duration, 'ms');

    return {
      startPrompt: parsed.startFrame.trim(),
      endPrompt: parsed.endFrame.trim()
    };
  } catch (error: any) {
    console.error('❌ AI关键帧优化失败:', error);
    throw new Error(`AI关键帧优化失败: ${error.message}`);
  }
};

/**
 * AI优化单个关键帧视觉描述（兼容旧版，建议使用 optimizeBothKeyframes）
 */
export const optimizeKeyframePrompt = async (
  frameType: 'start' | 'end',
  actionSummary: string,
  cameraMovement: string,
  sceneInfo: { location: string; time: string; atmosphere: string },
  characterInfo: string[],
  visualStyle: string,
  model: string = ''
): Promise<string> => {
  console.log(`🎨 optimizeKeyframePrompt 调用 - ${frameType === 'start' ? '起始帧' : '结束帧'} - 使用模型:`, model);
  const startTime = Date.now();

  const frameLabel = frameType === 'start' ? '起始帧' : '结束帧';
  const frameFocus = frameType === 'start'
    ? '初始状态、起始姿态、预备动作、场景建立'
    : '最终状态、结束姿态、动作完成、情绪高潮';

  const styleDesc = getStylePromptCN(visualStyle);

  const prompt = `
你是一位专业的电影视觉导演和概念艺术家。请为以下镜头的${frameLabel}创作详细的视觉描述。

## 场景信息
**地点：** ${sceneInfo.location}
**时间：** ${sceneInfo.time}
**氛围：** ${sceneInfo.atmosphere}

## 叙事动作
${actionSummary}

## 镜头运动
${cameraMovement}

## 角色信息
${characterInfo.length > 0 ? characterInfo.join('、') : '无特定角色'}

## 视觉风格
${styleDesc}

## 任务要求

作为${frameLabel}，你需要重点描述：**${frameFocus}**

### ${frameType === 'start' ? '起始帧' : '结束帧'}特殊要求：
${frameType === 'start' ? `
• 建立清晰的初始场景和人物状态
• 为即将发生的动作预留视觉空间和动势
• 设定光影和色调基调
• 展现角色的起始表情、姿态和位置
• 根据镜头运动（${cameraMovement}）设置合适的初始构图
• 营造场景氛围，让观众明确故事的起点
` : `
• 展现动作完成后的最终状态和结果
• 体现镜头运动（${cameraMovement}）带来的视角和构图变化
• 展现角色的情绪变化、最终姿态和位置
• 可以有戏剧性的光影和色彩变化
• 达到视觉高潮或情绪释放点
• 为下一个镜头的衔接做准备
`}

### 必须包含的视觉元素：

**1. 构图与景别**
- 根据镜头运动确定画面框架和视角
- 主体在画面中的位置和大小
- 前景、中景、背景的层次关系

**2. 光影与色彩**
- 光源的方向、强度和色温
- 主光、辅光、轮廓光的配置
- 整体色调和色彩情绪（暖色/冷色）
- 阴影的长度和密度

**3. 角色细节**（如有）
- 面部表情和眼神方向
- 肢体姿态和重心分布
- 服装状态和细节
- 与环境的互动关系

**4. 环境细节**
- 场景的具体视觉元素
- 环境氛围（雾气、光束、粒子等）
- 背景的清晰度和景深效果
- 环境对叙事的支持

**5. 运动暗示**
- 动态模糊或静止清晰
- 运动方向的视觉引导
- 张力和动势的体现

**6. 电影感细节**
- 画面质感和材质
- 大气透视效果
- 电影级的视觉特征

## 输出格式

请直接输出简洁但详细的视觉描述，约100-150字，用中文。

❌ 避免：
- 不要包含"Visual Style:"等标签
- 不要分段或使用项目符号
- 不要过于技术化的术语
- 不要描述整个动作过程，只描述这一帧的画面

✅ 追求：
- 流畅的单段描述
- 富有画面感的语言
- 突出${frameLabel}的特点
- 与叙事动作和镜头运动协调一致
- 具体、可视觉化的细节

请开始创作这一帧的视觉描述：
`;

  try {
    const result = await retryOperation(() => chatCompletion(prompt, model, 0.7, 1024));
    const duration = Date.now() - startTime;

    console.log(`✅ AI ${frameLabel}优化成功，耗时:`, duration, 'ms');

    return result.trim();
  } catch (error: any) {
    console.error(`❌ AI ${frameLabel}优化失败:`, error);
    throw new Error(`AI ${frameLabel}优化失败: ${error.message}`);
  }
};

// ============================================
// 动作生成
// ============================================

/**
 * AI生成叙事动作建议
 */
export const generateActionSuggestion = async (
  startFramePrompt: string,
  endFramePrompt: string,
  cameraMovement: string,
  model: string = '',
  targetDurationSeconds: number = 8
): Promise<string> => {
  console.log('🎬 generateActionSuggestion 调用 - 使用模型:', model);
  const startTime = Date.now();
  const normalizedDuration = Math.max(2, Math.min(20, Math.round(targetDurationSeconds * 10) / 10));

  const actionReferenceExamples = `
## 单镜头高质量参考（结构参考，不要照抄）

### 示例A：压迫推进
角色在雨夜天台静立，镜头低位缓慢推近，背景霓虹被雨幕拉出光带。角色抬手瞬间，画面出现短促电弧与风压波纹，镜头保持连续推进，最终停在半身近景，表情从平静过渡到决断，动作收于蓄力完成。

### 示例B：高速位移
镜头与角色平行跟拍，先中景稳定滑行，随后角色突然加速，画面边缘出现可控运动模糊与拖影。镜头不切换，只做同向快速平移并微微拉近，最终在角色前方刹停，落在近景对峙姿态。

### 示例C：情绪爆发
镜头从肩后视角开始缓慢环绕，角色呼吸急促、手部发抖，环境光由冷色逐步转暖。环绕到正面时角色完成关键动作，粒子与体积光同步增强，镜头在特写处稳定落点，形成情绪高潮与动作终点。`;

  const prompt = `
你是一位专业的电影动作导演和叙事顾问。请根据提供的首帧和尾帧信息，结合镜头运动，设计一个既符合叙事逻辑又充满视觉冲击力的动作场景。

## 重要约束
⏱️ **时长限制**：目标总时长约 ${normalizedDuration} 秒（允许±0.5秒），请严格控制动作复杂度
📹 **镜头要求**：这是一个连续镜头，不要设计多个镜头切换

## 输入信息
**首帧描述：** ${startFramePrompt}
**尾帧描述：** ${endFramePrompt}
**镜头运动：** ${cameraMovement}

${actionReferenceExamples}

## 任务要求
1. **时长适配**：动作设计必须能在约 ${normalizedDuration} 秒内完成，避免超负荷动作链
2. **单镜头思维**：优先设计一个连贯的镜头内动作，而非多镜头组合
3. **自然衔接**：动作需要自然地从首帧过渡到尾帧，确保逻辑合理
4. **风格借鉴**：参考上述示例的风格和语言，但要简化步骤：
   - 富有张力但简洁的描述语言
   - 强调关键的视觉冲击点
   - 电影级的运镜描述但避免过度分解
5. **创新适配**：不要重复已有提示词，结合当前场景创新
6. **镜头语言**：根据提供的镜头运动（${cameraMovement}），设计相应的运镜方案

## 输出格式
请直接输出动作描述文本，无需JSON格式或额外标记。内容应包含：
- 简洁的单镜头动作场景描述（不要“镜头1、镜头2...”分段）
- 关键的运镜说明（推拉摇移等）
- 核心的视觉特效或情感氛围
- 确保描述具有电影感但控制篇幅

❌ 避免：任何多镜头切换、冗长分步描述、时长明显超出 ${normalizedDuration} 秒负荷的复杂动作序列
✅ 追求：精炼、有冲击力、符合约 ${normalizedDuration} 秒时长的单镜头动作

请开始创作：
`;

  try {
    const result = await retryOperation(() => chatCompletion(prompt, model, 0.8, 2048));
    const duration = Date.now() - startTime;

    console.log('✅ AI动作生成成功，耗时:', duration, 'ms');

    return result.trim();
  } catch (error: any) {
    console.error('❌ AI动作生成失败:', error);
    throw new Error(`AI动作生成失败: ${error.message}`);
  }
};

// ============================================
// 镜头拆分
// ============================================

/**
 * AI镜头拆分功能 - 将单个镜头拆分为多个细致的子镜头
 */
export const splitShotIntoSubShots = async (
  shot: any,
  sceneInfo: { location: string; time: string; atmosphere: string },
  characterNames: string[],
  visualStyle: string,
  model: string = ''
): Promise<{ subShots: any[] }> => {
  console.log('✂️ splitShotIntoSubShots 调用 - 使用模型:', model);
  const startTime = Date.now();

  const styleDesc = getStylePromptCN(visualStyle);

  const prompt = `
你是一位专业的电影分镜师和导演。你的任务是将一个粗略的镜头描述，拆分为多个细致、专业的子镜头。

## 原始镜头信息

**场景地点：** ${sceneInfo.location}
**场景时间：** ${sceneInfo.time}
**场景氛围：** ${sceneInfo.atmosphere}
**角色：** ${characterNames.length > 0 ? characterNames.join('、') : '无特定角色'}
**视觉风格：** ${styleDesc}
**原始镜头运动：** ${shot.cameraMovement || '未指定'}

**原始动作描述：**
${shot.actionSummary}

${shot.dialogue ? `**对白：** "${shot.dialogue}"

⚠️ **对白处理说明**：原始镜头包含对白。请在拆分时，将对白放在最合适的子镜头中（通常是角色说话的中景或近景镜头），并在该子镜头的actionSummary中明确提及对白内容。其他子镜头不需要包含对白。` : ''}

## 拆分要求

### 核心原则
1. **单一职责**：每个子镜头只负责一个视角或动作细节，避免混合多个视角
2. **时长控制**：每个子镜头时长约2-4秒，总时长保持在8-10秒左右
3. **景别多样化**：合理运用全景、中景、特写等不同景别
4. **连贯性**：子镜头之间要有逻辑的视觉过渡和叙事连贯性

### 拆分维度示例

**景别分类（Shot Size）：**
- **远景 Long Shot / 全景 Wide Shot**：展示整体环境、人物位置关系、空间布局
- **中景 Medium Shot**：展示人物上半身或腰部以上，强调动作和表情
- **近景 Close-up**：展示人物头部或重要物体，强调情感和细节
- **特写 Extreme Close-up**：聚焦关键细节（如手部动作、眼神、物体特写）

### 必须包含的字段

每个子镜头必须包含以下信息：

1. **shotSize**（景别）：明确标注景别类型
2. **cameraMovement**（镜头运动）：描述镜头如何移动
3. **actionSummary**（动作描述）：清晰、具体的动作和画面内容描述（60-100字）
4. **visualFocus**（视觉焦点）：这个镜头的视觉重点
5. **keyframes**（关键帧数组）：包含起始帧(start)和结束帧(end)的视觉描述

### 专业镜头运动参考
- 静止镜头 Static Shot
- 推镜头 Dolly Shot / 拉镜头 Zoom Out
- 跟踪镜头 Tracking Shot
- 平移镜头 Pan Shot
- 环绕镜头 Circular Shot
- 俯视镜头 High Angle / 仰视镜头 Low Angle
- 主观视角 POV Shot
- 越肩镜头 Over the Shoulder

## 输出格式

请输出JSON格式，结构如下：

\`\`\`json
{
  "subShots": [
    {
      "shotSize": "全景 Wide Shot",
      "cameraMovement": "静止镜头 Static Shot",
      "actionSummary": "动作描述...",
      "visualFocus": "视觉焦点描述",
      "keyframes": [
        {
          "type": "start",
          "visualPrompt": "起始帧视觉描述，${styleDesc}，100-150字..."
        },
        {
          "type": "end",
          "visualPrompt": "结束帧视觉描述，${styleDesc}，100-150字..."
        }
      ]
    }
  ]
}
\`\`\`

**关键帧visualPrompt要求**：
- 必须包含视觉风格标记（${styleDesc}）
- 详细描述画面构图、光影、色彩、景深等视觉元素
- 起始帧和结束帧要有明显的视觉差异
- 长度控制在100-150字

## 重要提示

❌ **避免：**
- 不要在单个子镜头中混合多个视角或景别
- 不要拆分过细导致总时长超过10秒
- 不要忽略视觉连贯性

✅ **追求：**
- 每个子镜头职责清晰、画面感强
- 景别和视角多样化但符合叙事逻辑
- 保持电影级的专业表达

请开始拆分，直接输出JSON格式（不要包含markdown代码块标记）：
`;

  try {
    const result = await retryOperation(() => chatCompletion(prompt, model, 0.7, 4096, 'json_object'));
    const duration = Date.now() - startTime;

    const cleaned = cleanJsonString(result);
    const parsed = JSON.parse(cleaned);

    if (!parsed.subShots || !Array.isArray(parsed.subShots) || parsed.subShots.length === 0) {
      throw new Error('AI返回的JSON格式不正确或子镜头数组为空');
    }

    // 验证每个子镜头
    for (const subShot of parsed.subShots) {
      if (!subShot.shotSize || !subShot.cameraMovement || !subShot.actionSummary || !subShot.visualFocus) {
        throw new Error('子镜头缺少必需字段（shotSize、cameraMovement、actionSummary、visualFocus）');
      }
      if (!subShot.keyframes || !Array.isArray(subShot.keyframes) || subShot.keyframes.length === 0) {
        throw new Error('子镜头缺少关键帧数组（keyframes）');
      }
      for (const kf of subShot.keyframes) {
        if (!kf.type || !kf.visualPrompt) {
          throw new Error('关键帧缺少必需字段（type、visualPrompt）');
        }
        if (kf.type !== 'start' && kf.type !== 'end') {
          throw new Error('关键帧type必须是"start"或"end"');
        }
      }
    }

    console.log(`✅ 镜头拆分成功，生成 ${parsed.subShots.length} 个子镜头，耗时:`, duration, 'ms');

    addRenderLogWithTokens({
      type: 'script-parsing',
      resourceId: `shot-split-${shot.id}-${Date.now()}`,
      resourceName: `镜头拆分 - ${shot.actionSummary.substring(0, 30)}...`,
      status: 'success',
      model: model,
      prompt: prompt.substring(0, 200) + '...',
      duration: duration
    });

    return parsed;
  } catch (error: any) {
    console.error('❌ 镜头拆分失败:', error);

    addRenderLogWithTokens({
      type: 'script-parsing',
      resourceId: `shot-split-${shot.id}-${Date.now()}`,
      resourceName: `镜头拆分 - ${shot.actionSummary.substring(0, 30)}...`,
      status: 'failed',
      model: model,
      prompt: prompt.substring(0, 200) + '...',
      error: error.message,
      duration: Date.now() - startTime
    });

    throw new Error(`镜头拆分失败: ${error.message}`);
  }
};

// ============================================
// 关键帧增强
// ============================================

/**
 * AI增强关键帧提示词 - 添加详细的技术规格和视觉细节
 */
export const enhanceKeyframePrompt = async (
  basePrompt: string,
  visualStyle: string,
  cameraMovement: string,
  frameType: 'start' | 'end',
  model: string = ''
): Promise<string> => {
  console.log(`🎨 enhanceKeyframePrompt 调用 - ${frameType === 'start' ? '起始帧' : '结束帧'} - 使用模型:`, model);
  const startTime = Date.now();

  const styleDesc = getStylePromptCN(visualStyle);
  const frameLabel = frameType === 'start' ? '起始帧' : '结束帧';

  const prompt = `
你是一位资深的电影摄影指导与提示词工程师。请将“基础提示词”重写为可直接用于图像生成的最终提示词。

## 基础提示词
${basePrompt}

## 视觉风格
${styleDesc}

## 镜头运动
${cameraMovement}

## ${frameLabel}重点
${frameType === 'start'
  ? '建立清晰起点：主体初始姿态、空间关系、光线基调，并为后续运动预留视觉空间。'
  : '呈现明确终点：动作结果、姿态与情绪变化，并与起始状态形成可推导的连续变化。'}

## 任务要求
1. 必须保留并整合基础提示词中的核心信息，不丢失主体、场景、动作与镜头运动。
2. 强化电影感细节（构图、光影、景深、材质、氛围），但不要堆砌术语。
3. 如存在角色一致性要求，必须保留并强调“外观不可漂移”。
4. 输出必须是“单段中文提示词”，不要分节、不要项目符号、不要Markdown。
5. 不要重复基础提示词同义句，避免冗长；控制在120-220字。

仅输出最终提示词文本:
`;

  try {
    const result = await retryOperation(() => chatCompletion(prompt, model, 0.6, 1536));
    const duration = Date.now() - startTime;

    console.log(`✅ AI ${frameLabel}增强成功，耗时:`, duration, 'ms');

    return result.trim();
  } catch (error: any) {
    console.error(`❌ AI ${frameLabel}增强失败:`, error);
    console.warn('⚠️ 回退到基础提示词');
    return basePrompt;
  }
};

// ============================================
// 九宫格分镜预览
// ============================================

/**
 * 使用 Chat 模型将镜头动作拆分为网格分镜（4/6/9）
 */
export const generateNineGridPanels = async (
  actionSummary: string,
  cameraMovement: string,
  sceneInfo: { location: string; time: string; atmosphere: string },
  characterNames: string[],
  visualStyle: string,
  model?: string,
  panelCount: StoryboardGridPanelCount = 9,
  promptTemplates?: PromptTemplateConfig
): Promise<NineGridPanel[]> => {
  const startTime = Date.now();
  const layout = resolveStoryboardGridLayout(panelCount);
  const gridLayout = `${layout.cols}x${layout.rows}`;
  const templates = promptTemplates || resolvePromptTemplateConfig();
  const splitSystemTemplate = withTemplateFallback(
    templates.nineGrid.splitSystem,
    withTemplateFallback(
      DEFAULT_PROMPT_TEMPLATE_CONFIG.nineGrid.splitSystem,
      NINE_GRID_SPLIT_PROMPT.system
    )
  );
  const splitUserTemplate = withTemplateFallback(
    templates.nineGrid.splitUser,
    withTemplateFallback(
      DEFAULT_PROMPT_TEMPLATE_CONFIG.nineGrid.splitUser,
      NINE_GRID_SPLIT_PROMPT.user
    )
  );
  console.log(`🎬 ${layout.label}分镜 - 开始AI拆分视角...`);

  const resolvedModel = model || getActiveChatModel()?.id || '';
  const systemPrompt = renderPromptTemplate(
    splitSystemTemplate,
    {
      panelCount: layout.panelCount,
      gridLayout,
    }
  );
  const userPrompt = renderPromptTemplate(
    splitUserTemplate,
    {
      panelCount: layout.panelCount,
      lastIndex: layout.panelCount - 1,
      gridLayout,
      actionSummary,
      cameraMovement,
      location: sceneInfo.location,
      time: sceneInfo.time,
      atmosphere: sceneInfo.atmosphere,
      characters: characterNames.length > 0 ? characterNames.join('、') : '无特定角色',
      visualStyle,
    }
  );

  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

  const parsePanels = (responseText: string): NineGridPanel[] => {
    const cleaned = cleanJsonString(responseText);
    const parsed = JSON.parse(cleaned);
    const rawPanels = Array.isArray(parsed?.panels) ? parsed.panels : [];

    if (rawPanels.length !== layout.panelCount) {
      throw new Error(`AI返回的panel数量为 ${rawPanels.length}，必须为 ${layout.panelCount}`);
    }

    const normalizedPanels = rawPanels.map((p: any, idx: number) => ({
      index: idx,
      shotSize: String(p?.shotSize || '').trim(),
      cameraAngle: String(p?.cameraAngle || '').trim(),
      description: String(p?.description || '').trim(),
    }));

    const invalidPanel = normalizedPanels.find(p => !p.shotSize || !p.cameraAngle || !p.description);
    if (invalidPanel) {
      throw new Error('AI返回的panel字段不完整（shotSize/cameraAngle/description 不能为空）');
    }

    const invalidLengthPanel = normalizedPanels.find((p) => {
      const words = countEnglishWords(p.description);
      return words < 10 || words > 30;
    });
    if (invalidLengthPanel) {
      const words = countEnglishWords(invalidLengthPanel.description);
      throw new Error(`panel description 词数超出范围（当前 ${words}，要求 10-30）`);
    }

    return normalizedPanels;
  };

  try {
    const responseText = await retryOperation(() => chatCompletion(fullPrompt, resolvedModel, 0.7, 4096, 'json_object'));
    const duration = Date.now() - startTime;

    let panels: NineGridPanel[];
    try {
      panels = parsePanels(responseText);
    } catch (parseError: any) {
      console.warn(`⚠️ ${layout.label}首次解析不符合规范，尝试自动纠偏重试:`, parseError.message);
      const repairPrompt = `${fullPrompt}

你上一次输出不符合要求（原因：${parseError.message}）。
请严格重新输出 JSON 对象，且必须满足：
1) "panels" 恰好 ${layout.panelCount} 个（index 0-${layout.panelCount - 1}，按从左到右、从上到下）
2) 每个 panel 必须包含非空的 shotSize、cameraAngle、description
3) description 使用英文单句，严格控制在 10-30 词
4) 只输出 JSON，不要任何解释文字`;

      const repairedText = await retryOperation(() => chatCompletion(repairPrompt, resolvedModel, 0.4, 4096, 'json_object'));
      panels = parsePanels(repairedText);
    }

    console.log(`✅ ${layout.label}分镜 - AI拆分完成，耗时: ${duration}ms`);
    return panels;
  } catch (error: any) {
    console.error(`❌ ${layout.label}分镜 - AI拆分失败:`, error);
    throw new Error(`${layout.label}视角拆分失败: ${error.message}`);
  }
};

/**
 * 使用图像模型生成网格分镜图片（4/6/9）
 */
export const generateNineGridImage = async (
  panels: NineGridPanel[],
  referenceImages: string[] = [],
  visualStyle: string,
  aspectRatio: AspectRatio = '16:9',
  options?: {
    hasTurnaround?: boolean;
    panelCount?: StoryboardGridPanelCount;
    promptTemplates?: PromptTemplateConfig;
  }
): Promise<string> => {
  const startTime = Date.now();
  const layout = resolveStoryboardGridLayout(options?.panelCount || panels.length);
  const gridLayout = `${layout.cols}x${layout.rows}`;
  const templates = options?.promptTemplates || resolvePromptTemplateConfig();
  const imagePrefixTemplate = withTemplateFallback(
    templates.nineGrid.imagePrefix,
    withTemplateFallback(
      DEFAULT_PROMPT_TEMPLATE_CONFIG.nineGrid.imagePrefix,
      NINE_GRID_IMAGE_PROMPT_TEMPLATE.prefix
    )
  );
  const imagePanelTemplate = withTemplateFallback(
    templates.nineGrid.imagePanelTemplate,
    withTemplateFallback(
      DEFAULT_PROMPT_TEMPLATE_CONFIG.nineGrid.imagePanelTemplate,
      NINE_GRID_IMAGE_PROMPT_TEMPLATE.panelTemplate
    )
  );
  const imageSuffixTemplate = withTemplateFallback(
    templates.nineGrid.imageSuffix,
    withTemplateFallback(
      DEFAULT_PROMPT_TEMPLATE_CONFIG.nineGrid.imageSuffix,
      NINE_GRID_IMAGE_PROMPT_TEMPLATE.suffix
    )
  );
  console.log(`🎬 ${layout.label}分镜 - 开始生成网格图片...`);

  const stylePrompt = getStylePrompt(visualStyle);

  if (panels.length !== layout.panelCount) {
    throw new Error(`网格图片生成前校验失败：panels 数量为 ${panels.length}，必须为 ${layout.panelCount}`);
  }

  const panelDescriptions = panels.map((panel, idx) =>
    renderPromptTemplate(
      imagePanelTemplate,
      {
        index: idx + 1,
        position: layout.positionLabels[idx] || `Panel-${idx + 1}`,
        shotSize: panel.shotSize,
        cameraAngle: panel.cameraAngle,
        description: panel.description,
      }
    )
  ).join('\n');

  const nineGridPrompt = `${renderPromptTemplate(
    imagePrefixTemplate,
    {
      gridLayout,
      panelCount: layout.panelCount,
      visualStyle: stylePrompt,
    }
  )}
${panelDescriptions}

${renderPromptTemplate(
  imageSuffixTemplate,
  {
    gridLayout,
    panelCount: layout.panelCount,
  }
)}`;

  try {
    const imageUrl = await generateImage(
      nineGridPrompt,
      referenceImages,
      aspectRatio,
      false,
      !!options?.hasTurnaround,
      '',
      { referencePackType: 'shot' }
    );
    const duration = Date.now() - startTime;

    console.log(`✅ ${layout.label}分镜 - 图片生成完成，耗时: ${duration}ms`);
    return imageUrl;
  } catch (error: any) {
    console.error(`❌ ${layout.label}分镜 - 图片生成失败:`, error);
    throw new Error(`${layout.label}图片生成失败: ${error.message}`);
  }
};

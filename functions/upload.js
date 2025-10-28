import { errorHandling, telemetryData } from "./utils/middleware";

function UnauthorizedException(reason = 'Unauthorized') {
    return new Response(reason, {
        status: 401,
        statusText: 'Unauthorized',
        headers: {
            'Content-Type': 'text/plain;charset=UTF-8',
            // Disables caching by default.
            'Cache-Control': 'no-store',
            // Returns the "Content-Length" header for HTTP HEAD requests.
            'Content-Length': reason.length,
        },
    });
}

function getCorsHeaders(request, env) {
    const baseHeaders = {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Expose-Headers': '*',
        'Access-Control-Allow-Credentials': 'true'
    };
    // Read allowed origins from environment. Default to '*' for backward compatibility or ease of setup.
    const allowedOriginsStr = env.ALLOWED_ORIGINS || '*';
    if (allowedOriginsStr === '*') {
        return {
            ...baseHeaders,
            'Access-Control-Allow-Origin': '*',
        };
    }
    const requestOrigin = request.headers.get('Origin');
    const allowedOrigins = allowedOriginsStr.split(',').map(origin => origin.trim());
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
        return {
            ...baseHeaders,
            'Access-Control-Allow-Origin': requestOrigin,
        };
    }
    return baseHeaders;
}
export async function onRequestOptions(context) {
    const { request, env } = context;
    const headers = getCorsHeaders(request, env);
    const newHeaders = new Headers();
    for (let key in headers) {
        newHeaders.set(key, headers[key]);
    }
    const authorization = request.headers.get('Authorization');
    if (env.Authorization && env.Authorization !== authorization) {
        return UnauthorizedException(`${env.Authorization}-${authorization}`);
    }
    return new Response(null, {
        status: 204,
        headers: newHeaders,
    });
}
function jsonResponse(body, status = 200, context) {
    const { request, env } = context;
    const baseHeaders = { 'Content-Type': 'application/json' };
    const corsHeaders = getCorsHeaders(request, env);
    const newHeaders = new Headers();
    for (let key in baseHeaders) {
        newHeaders.set(key, baseHeaders[key]);
    }
    for (let key in corsHeaders) {
        newHeaders.set(key, corsHeaders[key]);
    }
    return new Response(JSON.stringify(body), {
        status,
        headers: newHeaders,
    });
}

export async function onRequestPost(context) {
    const { request, env } = context;

    const authorization = request.headers.get('Authorization');
    if (env.Authorization && env.Authorization !== authorization) {
        return UnauthorizedException(`${env.Authorization}-${authorization}`);
    }
    try {
        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        await errorHandling(context);
        telemetryData(context);

        const uploadFile = formData.get('file');
        if (!uploadFile || typeof uploadFile === 'string') {
            return jsonResponse({ error: 'No file uploaded or invalid file data.' }, 400, context);
        }
        const fileName = uploadFile.name;
        const fileExtension = fileName.split('.').pop().toLowerCase();

        const telegramFormData = new FormData();
        telegramFormData.append("chat_id", env.TG_Chat_ID);

        // 根据文件类型选择合适的上传方式
        let apiEndpoint;
        if (uploadFile.type.startsWith('image/')) {
            telegramFormData.append("photo", uploadFile);
            apiEndpoint = 'sendPhoto';
        } else if (uploadFile.type.startsWith('audio/')) {
            telegramFormData.append("audio", uploadFile);
            apiEndpoint = 'sendAudio';
        } else if (uploadFile.type.startsWith('video/')) {
            telegramFormData.append("video", uploadFile);
            apiEndpoint = 'sendVideo';
        } else {
            telegramFormData.append("document", uploadFile);
            apiEndpoint = 'sendDocument';
        }

        const result = await sendToTelegram(telegramFormData, apiEndpoint, env);

        if (!result.success) {
            throw new Error(result.error);
        }

        const fileId = getFileId(result.data);

        if (!fileId) {
            throw new Error('Failed to get file ID');
        }

        // 将文件信息保存到 KV 存储
        if (env.img_url) {
            await env.img_url.put(`${fileId}.${fileExtension}`, "", {
                metadata: {
                    TimeStamp: Date.now(),
                    ListType: "None",
                    Label: "None",
                    liked: false,
                    fileName: fileName,
                    fileSize: uploadFile.size,
                }
            });
        }
        return jsonResponse([{ 'src': `/file/${fileId}.${fileExtension}` }], 200, context);
    } catch (error) {
        console.error('Upload error:', error);
        return jsonResponse({ error: error.message }, 500, context);
    }
}

function getFileId(response) {
    if (!response.ok || !response.result) return null;

    const result = response.result;
    if (result.photo) {
        return result.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        ).file_id;
    }
    if (result.document) return result.document.file_id;
    if (result.video) return result.video.file_id;
    if (result.audio) return result.audio.file_id;

    return null;
}

async function sendToTelegram(formData, apiEndpoint, env, retryCount = 0) {
    const MAX_RETRIES = 2;
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;

    try {
        const response = await fetch(apiUrl, { method: "POST", body: formData });
        const responseData = await response.json();

        if (response.ok) {
            return { success: true, data: responseData };
        }

        // 图片上传失败时转为文档方式重试
        if (retryCount < MAX_RETRIES && apiEndpoint === 'sendPhoto') {
            console.log('Retrying image as document...');
            const newFormData = new FormData();
            newFormData.append('chat_id', formData.get('chat_id'));
            newFormData.append('document', formData.get('photo'));
            return await sendToTelegram(newFormData, 'sendDocument', env, retryCount + 1);
        }

        return {
            success: false,
            error: responseData.description || 'Upload to Telegram failed'
        };
    } catch (error) {
        console.error('Network error:', error);
        if (retryCount < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
            return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
        }
        return { success: false, error: 'Network error occurred' };
    }
}
const axios = require('axios');
const { CONFIG } = require('./config');

/**
 * 发送 Bark 通知 (POST 接口)
 * @param {Object} options 配置项
 * @param {string} options.title 标题
 * @param {string} options.body 内容
 * @param {string} [options.level='active'] 通知级别: active, timeSensitive, passive
 * @param {string} [options.group='其他通知'] 分组名称
 * @param {string} [options.url=''] 跳转链接
 * @param {string} [options.icon=''] 通知图标 URL
 * @param {string} [options.image=''] 通知图片 URL
 */
async function sendBarkNotification(options) {
    const key = CONFIG.barkKey;
    if (!key) return;

    const { title, body, level = 'active', group = '其他通知', url = '', icon = '', image = '' } = options;

    try {
        // 提取推送 URL
        let barkBaseUrl = key;

        // 如果配置的是 key
        if (!barkBaseUrl.startsWith('http')) {
            barkBaseUrl = `https://api.day.app/${key}`;
        }
        
        const payload = {
            title,
            body,
            level,
            group,
            url,
            icon,
            image
        };

        // 过滤掉空值参数
        Object.keys(payload).forEach(key => {
            if (payload[key] === undefined || payload[key] === null || payload[key] === '') {
                delete payload[key];
            }
        });

        const response = await axios.post(barkBaseUrl, payload);
        if (response.data.code !== 200) {
            console.error(`[Bark] 发送失败: ${response.data.message || '未知错误'}`);
        }
    } catch (error) {
        console.error(`[Bark] 发送出错: ${error.message}`);
    }
}

module.exports = {
    sendBarkNotification
};

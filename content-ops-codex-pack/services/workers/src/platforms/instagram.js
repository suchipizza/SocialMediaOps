const GRAPH_API_VERSION = process.env.IG_GRAPH_API_VERSION || "v21.0";
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const GRAPH_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.IG_GRAPH_REQUEST_TIMEOUT_MS || "45000", 10);

function makePlatformError(code, message, options = {}) {
  const err = new Error(message || code);
  err.code = code;
  err.retryable = options.retryable ?? false;
  err.status = options.status ?? null;
  err.raw = options.raw ?? null;
  return err;
}

function buildGraphUrl(pathname, params = {}) {
  const url = new URL(`${GRAPH_BASE_URL}/${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "undefined" || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = parsePositiveInt(GRAPH_REQUEST_TIMEOUT_MS, 45000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw makePlatformError(
        "platform_upstream_timeout",
        `instagram_graph_timeout:${timeoutMs}`,
        { retryable: true }
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function isLikelyTransientMediaFetchError(message) {
  const text = String(message || "");
  if (!text) return false;
  return /only photo or video can be accepted as media type/i.test(text);
}

function mapGraphErrorCode(responseStatus, graphCode, graphSubcode, graphMessage) {
  if (responseStatus === 401 || graphCode === 190) return "platform_auth_invalid";
  if (responseStatus === 403 || graphCode === 10 || graphCode === 200) return "platform_permission_denied";
  if (isLikelyTransientMediaFetchError(graphMessage)) return "platform_media_unreachable";
  if (responseStatus === 400) return "platform_request_invalid";
  if (graphCode === 4 || graphCode === 17 || graphCode === 613) return "platform_rate_limited";
  if (isRetryableStatus(responseStatus)) return "platform_upstream_unavailable";
  if (graphSubcode === 2207008) return "platform_container_not_ready";
  return "platform_api_error";
}

async function graphGet(pathname, params = {}) {
  const response = await fetchWithTimeout(buildGraphUrl(pathname, params), {
    method: "GET"
  });
  const json = await readJsonSafe(response);
  if (response.ok && json) return json;
  const graphError = json?.error || {};
  const code = mapGraphErrorCode(response.status, graphError.code, graphError.error_subcode, graphError.message);
  throw makePlatformError(code, graphError.message || `graph_get_failed:${response.status}`, {
    status: response.status,
    retryable:
      isRetryableStatus(response.status) ||
      code === "platform_rate_limited" ||
      code === "platform_media_unreachable",
    raw: json
  });
}

async function graphPost(pathname, body = {}) {
  const encoded = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "undefined" || value === null || value === "") continue;
    encoded.set(key, String(value));
  }

  const response = await fetchWithTimeout(`${GRAPH_BASE_URL}/${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: encoded
  });
  const json = await readJsonSafe(response);
  if (response.ok && json) return json;
  const graphError = json?.error || {};
  const code = mapGraphErrorCode(response.status, graphError.code, graphError.error_subcode, graphError.message);
  throw makePlatformError(code, graphError.message || `graph_post_failed:${response.status}`, {
    status: response.status,
    retryable:
      isRetryableStatus(response.status) ||
      code === "platform_rate_limited" ||
      code === "platform_media_unreachable",
    raw: json
  });
}

async function waitForContainerReady({ creationId, accessToken, timeoutMs = 60000, pollMs = 2000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const details = await graphGet(creationId, {
      fields: "id,status_code,status",
      access_token: accessToken
    });
    const statusCode = String(details.status_code || details.status || "").toUpperCase();
    if (!statusCode || statusCode === "FINISHED" || statusCode === "PUBLISHED") return;
    if (statusCode === "ERROR" || statusCode === "EXPIRED") {
      throw makePlatformError("platform_container_error", `instagram_container_failed:${creationId}`, {
        retryable: false,
        raw: details
      });
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw makePlatformError("platform_container_timeout", `instagram_container_timeout:${creationId}`, {
    retryable: true
  });
}

export async function publishInstagramCarousel({
  igAccessToken,
  igUserId,
  imageUrls,
  caption
}) {
  const accessToken = String(igAccessToken || "").trim();
  const userId = String(igUserId || "").trim();
  if (!accessToken || !userId) {
    throw makePlatformError(
      "missing_platform_credentials",
      "missing_platform_credentials:instagram_requires_ig_access_token_and_ig_user_id",
      { retryable: false }
    );
  }
  if (!Array.isArray(imageUrls) || imageUrls.length < 2) {
    throw makePlatformError("platform_request_invalid", "instagram_requires_at_least_2_images_for_carousel", {
      retryable: false
    });
  }

  const childContainerIds = [];
  for (const imageUrl of imageUrls) {
    const container = await graphPost(`${userId}/media`, {
      image_url: imageUrl,
      is_carousel_item: true,
      access_token: accessToken
    });
    if (!container?.id) {
      throw makePlatformError("platform_api_error", "instagram_child_container_missing_id", {
        retryable: true,
        raw: container
      });
    }
    childContainerIds.push(container.id);
  }

  for (const childId of childContainerIds) {
    await waitForContainerReady({ creationId: childId, accessToken });
  }

  const carouselContainer = await graphPost(`${userId}/media`, {
    media_type: "CAROUSEL",
    children: childContainerIds.join(","),
    caption: caption || "",
    access_token: accessToken
  });
  const carouselId = carouselContainer?.id;
  if (!carouselId) {
    throw makePlatformError("platform_api_error", "instagram_carousel_container_missing_id", {
      retryable: true,
      raw: carouselContainer
    });
  }

  await waitForContainerReady({ creationId: carouselId, accessToken });

  const publishResponse = await graphPost(`${userId}/media_publish`, {
    creation_id: carouselId,
    access_token: accessToken
  });
  const mediaId = publishResponse?.id;
  if (!mediaId) {
    throw makePlatformError("platform_api_error", "instagram_publish_missing_media_id", {
      retryable: true,
      raw: publishResponse
    });
  }

  const publishedMedia = await graphGet(mediaId, {
    fields: "id,permalink,timestamp",
    access_token: accessToken
  });

  return {
    platform: "instagram",
    external_id: mediaId,
    permalink: publishedMedia?.permalink || null,
    published_at: publishedMedia?.timestamp || null,
    child_container_ids: childContainerIds,
    carousel_container_id: carouselId
  };
}

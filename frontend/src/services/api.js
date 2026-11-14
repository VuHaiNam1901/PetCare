// Địa chỉ API công khai, không chứa thông tin kết nối database.
export const API_ORIGIN = (import.meta.env?.VITE_API_ORIGIN ?? 'http://localhost:3000').trim().replace(/\/+$/, '');

export async function fetchCollection(endpoint, collectionKey, signal) {
  let response;
  try {
    response = await fetch(`${API_ORIGIN}${endpoint}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Chưa kết nối được với máy chủ. Vui lòng thử lại sau.');
  }

  if (!response.ok) {
    throw new Error('Chưa tải được dữ liệu. Vui lòng thử lại sau.');
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('Dữ liệu trả về chưa hợp lệ. Vui lòng thử lại.');
  }

  const rows = body?.[collectionKey];
  const idKey = collectionKey === 'products' ? 'product_id' : collectionKey === 'pet_types' ? 'pet_type_id' : 'category_id';
  if (
    body?.success !== true ||
    !Array.isArray(rows) ||
    !rows.every(row => row && row[idKey] != null && typeof row.name === 'string')
  ) {
    throw new Error('Dữ liệu trả về chưa hợp lệ. Vui lòng thử lại.');
  }
  return rows;
}

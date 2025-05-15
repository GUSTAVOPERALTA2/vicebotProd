// config/exportXLSX.js

const sqlite3 = require('sqlite3').verbose();
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { formatDate } = require('./dateUtils');
const { getUser } = require('./userManager');

/**
 * exportXLSX - Exporta las incidencias a un archivo XLSX con:
 *  - Hoja Resumen con encabezado, logo y gráfica de línea de tendencia diaria
 *  - Hoja Incidencias detalladas con encabezado y logo
 *  - Hoja Feedback con encabezado y logo
 *  - Filtrado opcional por fechas, categorías y estados
 *  - Nombre de archivo dinámico con timestamp y filtros
 */
async function exportXLSX(startDate, endDate, categories, statuses) {
  // 1) Leer datos de incidencias con filtros
  const dbPath = path.join(__dirname, '../data/incidencias.db');
  const db = new sqlite3.Database(dbPath);
  const clauses = [];
  const params = [];
  if (startDate) { clauses.push('fechaCreacion >= ?'); params.push(`${startDate}T00:00:00.000Z`); }
  if (endDate)   { clauses.push('fechaCreacion <= ?'); params.push(`${endDate}T23:59:59.999Z`); }
  if (categories && categories.length) {
    clauses.push(`(${categories.map(() => 'categoria LIKE ?').join(' OR ')})`);
    categories.forEach(c => params.push(`%${c}%`));
  }
  if (statuses && statuses.length) {
    clauses.push(`(${statuses.map(() => 'estado = ?').join(' OR ')})`);
    statuses.forEach(s => params.push(s));
  }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const sql = `SELECT id, descripcion, reportadoPor, fechaCreacion, estado, categoria, confirmaciones, feedbackHistory, fechaCancelacion FROM incidencias${where}`;
  const rows = await new Promise((res, rej) => db.all(sql, params, (err, data) => err ? rej(err) : res(data)));
  db.close();
  if (!rows.length) throw new Error('No hay incidencias para el filtro especificado');

  // 2) Preparar el workbook
  const workbook = new ExcelJS.Workbook();
  const now = moment().tz('America/Hermosillo');
  const ts = now.format('YYYYMMDD_HHmmss');
  const logoPath = path.join(__dirname, '../data/logo.png');

  // Construir texto header dinámico o GLOBAL si sin parámetros
  const sd = startDate ? moment.tz(startDate, 'YYYY-MM-DD', 'America/Hermosillo').format('DD/MM/YYYY') : null;
  const ed = endDate   ? moment.tz(endDate,   'YYYY-MM-DD', 'America/Hermosillo').format('DD/MM/YYYY') : null;
  const catLbl = categories && categories.length ? categories.map(c => c.toUpperCase()).join(', ') : null;
  const statLbl = statuses && statuses.length ? statuses.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(', ') : null;
  const noFilters = !startDate && !endDate && (!categories || categories.length === 0) && (!statuses || statuses.length === 0);
  let headerText;
  if (noFilters) {
    headerText = 'GLOBAL';
  } else {
    const parts = [];
    if (catLbl) parts.push(catLbl);
    if (sd && ed) parts.push(`${sd} - ${ed}`);
    else if (!sd && !ed) parts.push(now.format('DD/MM/YYYY'));
    if (statLbl) parts.push(statLbl);
    headerText = parts.join(' | ');
  }
  // 4) Hoja Incidencias detalladas
  const inc = workbook.addWorksheet('Incidencias');
  inc.columns = [
    { key: 'id', width: 10 },
    { key: 'descripcion', width: 40 },
    { key: 'reportadoPor', width: 30 },
    { key: 'fechaCreacion', width: 20 },
    { key: 'estado', width: 15 },
    { key: 'categoria', width: 15 },
    { key: 'confirmaciones', width: 30 },
    { key: 'fechaCancelacion', width: 20 }
  ];
  inc.getRow(1).height = 80;
  if (fs.existsSync(logoPath)) {
    const imgId = workbook.addImage({ filename: logoPath, extension: 'png' });
    inc.addImage(imgId, { tl: { col: 0, row: 0 }, br: { col: 2, row: 1 } });
  }
  inc.mergeCells(1, 3, 1, 8);
  const incHdr = inc.getCell('C1');
  incHdr.value = `REPORTE DE INCIDENCIAS ${headerText}`;
  incHdr.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  incHdr.alignment = { horizontal: 'center', vertical: 'middle' };
  incHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCC7722' } };
  inc.getRow(2).values = ['ID','Descripción','Reportado Por','Fecha Creación','Estado','Categoría','Confirmaciones','Fecha Cancelación'];
  inc.getRow(2).font = { bold: true };
  inc.views = [{ state: 'frozen', ySplit: 2 }];
  rows.forEach(r => {
    const usr = getUser(r.reportadoPor);
    const rep = usr ? `${usr.nombre} (${usr.cargo})` : r.reportadoPor;
    let conf = '';
    if (r.confirmaciones) {
      try {
        conf = Object.entries(JSON.parse(r.confirmaciones))
          .map(([t, ts]) => `${t}: ${formatDate(ts)}`)
          .join('\n');
      } catch {}
    }
    inc.addRow({
      id: r.id,
      descripcion: r.descripcion,
      reportadoPor: rep,
      fechaCreacion: formatDate(r.fechaCreacion),
      estado: r.estado.toUpperCase(),
      categoria: r.categoria.toUpperCase(),
      confirmaciones: conf,
      fechaCancelacion: r.fechaCancelacion ? formatDate(r.fechaCancelacion) : ''
    });
  });

  // 5) Hoja Feedback
  const fb = workbook.addWorksheet('Feedback');
  fb.getRow(1).height = 80;
  if (fs.existsSync(logoPath)) {
    const logoId2 = workbook.addImage({ filename: logoPath, extension: 'png' });
    fb.addImage(logoId2, { tl: { col: 0, row: 0 }, br: { col: 2, row: 1 } });
  }
  fb.mergeCells(1, 3, 1, 8);
  const fbHdr = fb.getCell('C1');
  fbHdr.value = `REPORTE DE INCIDENCIAS ${headerText}`;
  fbHdr.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  fbHdr.alignment = { horizontal: 'center', vertical: 'middle' };
  fbHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCC7722' } };
  fb.columns = [
    { key: 'incidenciaId', width: 10 },
    { key: 'equipo', width: 15 },
    { key: 'comentario', width: 50 },
    { key: 'fecha', width: 20 }
  ];
  fb.getRow(2).values = ['Incidencia ID','Equipo','Comentario','Fecha'];
  fb.getRow(2).font = { bold: true };
  fb.views = [{ state: 'frozen', ySplit: 2 }];
  rows.forEach(r => {
    if (r.feedbackHistory) {
      try {
        JSON.parse(r.feedbackHistory).forEach(rec => fb.addRow({
          incidenciaId: r.id,
          equipo: rec.equipo.toUpperCase(),
          comentario: rec.comentario,
          fecha: formatDate(rec.fecha)
        }));
      } catch {}
    }
  });

  // 6) Guardar archivo
  let filename = `incidencias_${ts}`;
  if (categories && categories.length) filename += `_${categories.join('-')}`;
  if (startDate && endDate) filename += `_${startDate.replace(/-/g, '')}-${endDate.replace(/-/g, '')}`;
  if (statuses && statuses.length) filename += `_${statuses.join('-')}`;
  filename += `.xlsx`;
  const outputPath = path.join(__dirname, '../data/reports', filename);
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

module.exports = { exportXLSX };

if (require.main === module) {
  const [,, start, end, ...rest] = process.argv;
  const validCats = ['it','man','ama'], validStats = ['pendiente','completada','cancelada'];
  const categories = [], statuses = [];
  rest.forEach(p => {
    const l = p.toLowerCase();
    if (validCats.includes(l)) categories.push(l);
    if (validStats.includes(l)) statuses.push(l);
  });
  exportXLSX(start, end,
    categories.length ? categories : undefined,
    statuses.length ? statuses : undefined
  )
  .then(p => console.log('Reporte generado en:', p))
  .catch(console.error);
}

// config/exportXLSX.js

const sqlite3 = require('sqlite3').verbose();
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const ChartJSNodeCanvas = require('chartjs-node-canvas').ChartJSNodeCanvas;
const { formatDate } = require('./dateUtils');
const { getUser } = require('./userManager');

function limpiarReportesAntiguos(dirPath, maxArchivos = 20) {
  try {
    const archivos = fs.readdirSync(dirPath)
      .map(name => ({
        name,
        time: fs.statSync(path.join(dirPath, name)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time); // más recientes primero

    const archivosExcedentes = archivos.slice(maxArchivos);
    for (const archivo of archivosExcedentes) {
      fs.unlinkSync(path.join(dirPath, archivo.name));
      console.log(`🗑️ Reporte eliminado: ${archivo.name}`);
    }
  } catch (err) {
    console.error('❌ Error limpiando reportes antiguos:', err);
  }
}


/**
 * exportXLSX - Exporta las incidencias a un archivo XLSX con:
 *  - Hoja Resumen con encabezado, logo y gráfica (opcional)
 *  - Hoja Incidencias detalladas con encabezado, logo, y nuevos campos:
 *      * CompletadoPorNombre: lista de todos los que confirmaron (incluye repeticiones)
 *      * FaseActual: confirmaciones/total
 *      * FechaFinalizacion: timestamp de última confirmación
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

  if (startDate) {
    clauses.push('fechaCreacion >= ?');
    params.push(moment.tz(startDate, 'America/Hermosillo').startOf('day').toISOString());
  }
  if (endDate) {
    clauses.push('fechaCreacion <= ?');
    params.push(moment.tz(endDate, 'America/Hermosillo').endOf('day').toISOString());
  }
  if (categories?.length) {
    clauses.push(
      `(${categories.map(() => "INSTR(',' || categoria || ',', ?) > 0").join(' OR ')})`
    );
    categories.forEach(c => params.push(`,${c},`));
  }
  
  if (statuses?.length) {
    clauses.push(`(${statuses.map(() => 'estado = ?').join(' OR ')})`);
    statuses.forEach(s => params.push(s));
  }

  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const sql = `SELECT id, descripcion, reportadoPor, fechaCreacion, estado, categoria, confirmaciones, feedbackHistory, fechaCancelacion FROM incidencias${where}`;

  const rows = await new Promise((res, rej) =>
    db.all(sql, params, (err, data) => (err ? rej(err) : res(data)))
  );
  db.close();
  if (!rows.length) throw new Error('No hay incidencias para el filtro especificado');

  // 2) Preparar el workbook
  const workbook = new ExcelJS.Workbook();
  const now = moment().tz('America/Hermosillo');
  const ts = now.format('YYYYMMDD_HHmmss');
  const logoPath = path.join(__dirname, '../data/logo.png');

  // Construir texto header dinámico
  const sd = startDate
    ? moment.tz(startDate, 'YYYY-MM-DD', 'America/Hermosillo').format('DD/MM/YYYY')
    : null;
  const ed = endDate
    ? moment.tz(endDate, 'YYYY-MM-DD', 'America/Hermosillo').format('DD/MM/YYYY')
    : null;
  const catLbl = categories?.length
    ? categories.map(c => c.toUpperCase()).join(', ')
    : null;
  const statLbl = statuses?.length
    ? statuses.map(s => s[0].toUpperCase() + s.slice(1)).join(', ')
    : null;
  const noFilters =
    !startDate &&
    !endDate &&
    (!categories || !categories.length) &&
    (!statuses || !statuses.length);
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

  // 3) Hoja Incidencias detalladas
  const inc = workbook.addWorksheet('Incidencias');
  inc.columns = [
    { header: 'ID', key: 'id', width: 10 },
    { header: 'Descripción', key: 'descripcion', width: 40 },
    { header: 'Reportado Por', key: 'reportadoPor', width: 30 },
    { header: 'Fecha Creación', key: 'fechaCreacion', width: 20 },
    { header: 'Estado', key: 'estado', width: 15 },
    { header: 'Categoría', key: 'categoria', width: 15 },
    { header: 'Confirmaciones', key: 'confirmaciones', width: 30 },
    { header: 'Completado Por', key: 'completadoPorNombre', width: 25 },
    { header: 'Fase Actual', key: 'faseActual', width: 15 },
    { header: 'Fecha Finalización', key: 'fechaFinalizacion', width: 20 },
    { header: 'Fecha Cancelación', key: 'fechaCancelacion', width: 20 }
  ];
  inc.getRow(1).height = 80;
  if (fs.existsSync(logoPath)) {
    const imgId = workbook.addImage({ filename: logoPath, extension: 'png' });
    inc.addImage(imgId, { tl: { col: 0, row: 0 }, br: { col: 2, row: 1 } });
  }
  inc.mergeCells(1, 1, 1, 11);
  const incHdr = inc.getCell('C1');
  incHdr.value = `REPORTE DE INCIDENCIAS ${headerText}`;
  incHdr.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  incHdr.alignment = { horizontal: 'center', vertical: 'middle' };
  incHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCC7722' } };
  inc.getRow(2).values = [
    'ID',
    'Descripción',
    'Reportado Por',
    'Fecha Creación',
    'Estado',
    'Categoría',
    'Confirmaciones',
    'Completado Por',
    'Fase Actual',
    'Fecha Finalización',
    'Fecha Cancelación'
  ];
  inc.getRow(2).font = { bold: true };
  inc.views = [{ state: 'frozen', ySplit: 2 }];

  // Llenar datos en Incidencias
  rows.forEach(r => {
    const usr = getUser(r.reportadoPor);
    const rep = usr ? `${usr.nombre} (${usr.cargo})` : r.reportadoPor;

    // Formato de confirmaciones
    let conf = '';
    if (r.confirmaciones) {
      try {
        conf = Object.entries(JSON.parse(r.confirmaciones))
          .map(([t, ts]) => `${t.toUpperCase()}: ${formatDate(ts)}`)
          .join('\n');
      } catch {}
    }

    // Historial de feedback
    let history = [];
    try {
      history = JSON.parse(r.feedbackHistory || '[]');
    } catch {}

    // Solo confirmaciones
    const confirmations = history.filter(h => h.tipo === 'confirmacion');

    // Lista de todos los confirmadores (incluye repeticiones) con cargo
    const completadoPorNombre = confirmations
      .map(h => {
        const u = getUser(h.usuario);
        return u ? `${u.nombre}(${u.cargo})` : h.usuario;
      })
      .join('\n');

    // Fecha de la última confirmación
    const lastDate =
      confirmations.length > 0 ? confirmations[confirmations.length - 1].fecha : null;
    const fechaFinalizacion = lastDate ? formatDate(lastDate) : '';

    // Fase actual vs total
    const teams = r.categoria.split(',').map(c => c.trim());
    const faseActual = `${confirmations.length} de ${teams.length}`;

    // 1) Añadir la fila y capturarla
    const newRow = inc.addRow({
      id: r.id,
      descripcion: r.descripcion,
      reportadoPor: rep,
      fechaCreacion: formatDate(r.fechaCreacion),
      estado: r.estado.toUpperCase(),
      categoria: r.categoria.toUpperCase(),
      confirmaciones: conf,
      completadoPorNombre,
      faseActual,
      fechaFinalizacion,
      fechaCancelacion: r.fechaCancelacion ? formatDate(r.fechaCancelacion) : ''
    });

    // 2) Pintar la celda de Estado (columna 5)
    const cell = newRow.getCell(5);
    const val = (r.estado || '').toLowerCase();
    if (val === 'completada') {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF00FF00' }
      };
    } else if (val === 'cancelada') {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFF0000' }
      };
    } else if (val === 'pendiente') {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFFFF00' }
      };
    }
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  // 5) Hoja Feedback
  const fb = workbook.addWorksheet('Feedback');
  fb.getRow(1).height = 80;
  if (fs.existsSync(logoPath)) {
    const logoId2 = workbook.addImage({ filename: logoPath, extension: 'png' });
    fb.addImage(logoId2, { tl: { col: 0, row: 0 }, br: { col: 2, row: 1 } });
  }
  fb.mergeCells(1, 1, 1, 4);
  const fbHdr = fb.getCell('C1');
  fbHdr.value = `REPORTE DE INCIDENCIAS ${headerText}`;
  fbHdr.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  fbHdr.alignment = { horizontal: 'center', vertical: 'middle' };
  fbHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCC7722' } };
  fb.columns = [
    { header: 'Incidencia ID', key: 'incidenciaId', width: 10 },
    { header: 'Equipo',        key: 'equipo',       width: 15 },
    { header: 'Usuario',       key: 'usuario',      width: 30 }, // <- Aquí cambiaremos para nombre y cargo
    { header: 'Comentario',    key: 'comentario',   width: 50 },
    { header: 'Fecha',         key: 'fecha',        width: 20 }
  ];
  fb.getRow(2).values = ['Incidencia ID', 'Equipo', 'Usuario', 'Comentario', 'Fecha'];
  fb.getRow(2).font = { bold: true };
  fb.views = [{ state: 'frozen', ySplit: 2 }];

  // Rellenar filas:
  rows.forEach(r => {
    try {
      // Por cada registro de feedback en JSON:
      JSON.parse(r.feedbackHistory || '[]').forEach(rec => {
        // 👉 Aquí obtenemos el usuario con nombre y cargo:
        let displayedUser = rec.usuario;
        const userRec = getUser(rec.usuario);
        if (userRec) {
          displayedUser = `${userRec.nombre} (${userRec.cargo})`;
        }

        fb.addRow({
          incidenciaId: r.id,
          equipo:       rec.equipo?.toUpperCase(),
          usuario:      displayedUser,    // <-- Antes era rec.usuario; ahora usamos nombre y cargo
          comentario:   rec.comentario,
          fecha:        rec.fecha ? formatDate(rec.fecha) : ''
        });
      });
    } catch {}
  });


  // 5) Guardar archivo con filtros en nombre
  let filename = `incidencias_${ts}`;
  if (categories?.length) filename += `_${categories.join('-')}`;
  if (startDate && endDate)
    filename += `_${startDate.replace(/-/g, '')}-${endDate.replace(/-/g, '')}`;
  if (statuses?.length) filename += `_${statuses.join('-')}`;
  filename += `.xlsx`;

  const reportsDir = path.join(__dirname, '../data/reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const outputPath = path.join(reportsDir, filename);

  await workbook.xlsx.writeFile(outputPath);
  limpiarReportesAntiguos(reportsDir); // 🔄 Eliminar archivos antiguos
  return outputPath;
}

module.exports = { exportXLSX };

/** Permite usar desde línea de comandos con filtros opcionales */
if (require.main === module) {
  const [,, start, end, ...rest] = process.argv;
  const validCats = ['it', 'man', 'ama'];
  const validStats = ['pendiente', 'completada', 'cancelada'];
  const categories = [];
  const statuses = [];

  rest.forEach(p => {
    const l = p.toLowerCase();
    if (validCats.includes(l)) categories.push(l);
    if (validStats.includes(l)) statuses.push(l);
  });

  exportXLSX(
    start || undefined,
    end || undefined,
    categories.length ? categories : undefined,
    statuses.length ? statuses : undefined
  )
    .then(p => console.log('Reporte generado en:', p))
    .catch(console.error);
}


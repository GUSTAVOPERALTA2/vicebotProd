// config/exportXLSX.js

const sqlite3 = require('sqlite3').verbose();
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const { formatDate } = require('./dateUtils');
const { getUser } = require('./userManager');

/**
 * exportXLSX - Exporta las incidencias a un XLSX con logo, encabezados estilizados
 * y configuración de impresión para un formato óptimo.
 */
async function exportXLSX() {
  // Conectar a la base de datos
  const dbPath = path.join(__dirname, '../data/incidencias.db');
  const db = new sqlite3.Database(dbPath);
  const rows = await new Promise((resolve, reject) => db.all(
    `SELECT id, descripcion, reportadoPor, fechaCreacion, estado,
            categoria, confirmaciones, feedbackHistory, fechaCancelacion
     FROM incidencias`,
    (err, data) => err ? reject(err) : resolve(data)
  ));
  db.close();

  if (!rows.length) throw new Error('No hay incidencias');

  const workbook = new ExcelJS.Workbook();
  const today = moment().tz('America/Hermosillo').format('DD/MM/YYYY');

  // ================= Hoja Incidencias =================
  const incSheet = workbook.addWorksheet('Incidencias');

  // Definir anchos de columnas
  incSheet.columns = [
    { key: 'id', width: 10 },
    { key: 'descripcion', width: 40 },
    { key: 'reportadoPor', width: 30 },
    { key: 'fechaCreacion', width: 20 },
    { key: 'estado', width: 15 },
    { key: 'categoria', width: 15 },
    { key: 'confirmaciones', width: 30 },
    { key: 'fechaCancelacion', width: 20 }
  ];

  // Configuración de impresión
  incSheet.pageSetup = {
    orientation: 'landscape',     // Horizontal
    fitToPage: true,
    fitToWidth: 1,               // Ajustar a 1 página de ancho
    fitToHeight: 0,              // Altura ilimitada
    margins: {
      left: 0.5, right: 0.5,
      top: 0.75, bottom: 0.75,
      header: 0.3, footer: 0.3
    },
    printTitlesRow: '2:2',       // Repetir fila 2 en cada página
    horizontalCentered: true
  };

  // Altura de fila 1 = 120px (~90pt)
  incSheet.getRow(1).height = 90;

  // Insertar logo en A1 (fila 1 altura) ocupando A1:B1
  const logoPath = path.join(__dirname, '../data/logo.png');
  if (fs.existsSync(logoPath)) {
    const logoId = workbook.addImage({ filename: logoPath, extension: 'png' });
    incSheet.addImage(logoId, { tl: { col: 0, row: 0 }, br: { col: 2, row: 1 } });
  }

  // Encabezado principal: C1 hasta H1
  const lastCol = incSheet.columns.length;
  incSheet.mergeCells(1, 3, 1, lastCol);
  const hdr = incSheet.getCell('C1');
  hdr.value = `REPORTE DE INCIDENCIAS ${today}`;
  hdr.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  hdr.alignment = { horizontal: 'center', vertical: 'middle' };
  hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCC7722' } };

  // Congelar encabezados
  incSheet.views = [{ state: 'frozen', ySplit: 2 }];

  // Fila 2: encabezados de columnas (desde A)
  incSheet.getRow(2).values = [
    'ID', 'Descripción', 'Reportado Por', 'Fecha Creación',
    'Estado', 'Categoría', 'Confirmaciones', 'Fecha Cancelación'
  ];
  incSheet.getRow(2).font = { bold: true };

  // ================= Hoja Feedback =================
  const fbSheet = workbook.addWorksheet('Feedback');

  fbSheet.columns = [
    { key: 'incidenciaId', width: 10 },
    { key: 'equipo', width: 15 },
    { key: 'comentario', width: 50 },
    { key: 'fecha', width: 20 }
  ];

  // Impresión feedback
  fbSheet.pageSetup = {
    orientation: 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
    printTitlesRow: '2:2',
    horizontalCentered: true
  };

  fbSheet.getRow(1).height = 90;

  // Logo en feedback A1:B1
  if (fs.existsSync(logoPath)) {
    const fbLogo = workbook.addImage({ filename: logoPath, extension: 'png' });
    fbSheet.addImage(fbLogo, { tl: { col: 0, row: 0 }, br: { col: 2, row: 1 } });
  }

  // Encabezado principal: C1 hasta última col
  const lastFb = fbSheet.columns.length;
  fbSheet.mergeCells(1, 3, 1, lastFb);
  const fbHdr = fbSheet.getCell('C1');
  fbHdr.value = `FEEDBACK DE INCIDENCIAS ${today}`;
  fbHdr.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  fbHdr.alignment = { horizontal: 'center', vertical: 'middle' };
  fbHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCC7722' } };

  fbSheet.views = [{ state: 'frozen', ySplit: 2 }];
  fbSheet.getRow(2).values = ['Incidencia ID', 'Equipo', 'Comentario', 'Fecha'];
  fbSheet.getRow(2).font = { bold: true };

  // Poblado de datos
  rows.forEach(r => {
    const user = getUser(r.reportadoPor);
    const reportedBy = user ? `${user.nombre} (${user.cargo})` : r.reportadoPor;
    const estado = r.estado.charAt(0).toUpperCase() + r.estado.slice(1);
    const categoria = r.categoria.toUpperCase();
    let confText = '';
    if (r.confirmaciones) {
      try {
        confText = Object.entries(JSON.parse(r.confirmaciones))
          .map(([team, ts]) => `${team.toUpperCase()}: ${formatDate(ts)}`)
          .join('\n');
      } catch {}
    }
    incSheet.addRow({
      id: r.id,
      descripcion: r.descripcion,
      reportadoPor: reportedBy,
      fechaCreacion: formatDate(r.fechaCreacion),
      estado,
      categoria,
      confirmaciones: confText,
      fechaCancelacion: r.fechaCancelacion ? formatDate(r.fechaCancelacion) : ''
    });
    if (r.feedbackHistory) {
      try {
        JSON.parse(r.feedbackHistory).forEach(fb => {
          fbSheet.addRow({
            incidenciaId: r.id,
            equipo: (fb.equipo || '').toUpperCase(),
            comentario: fb.comentario || '',
            fecha: formatDate(fb.fecha)
          });
        });
      } catch {}
    }
  });

  // Guardar archivo
  const outputPath = path.join(__dirname, '../data/incidencias_export.xlsx');
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

module.exports = { exportXLSX };

if (require.main === module) {
  exportXLSX()
    .then(p => console.log('Reporte generado en:', p))
    .catch(console.error);
}
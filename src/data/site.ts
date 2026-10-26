// datos del estudio que se repiten en contacto, footer y metadatos
export const SITE = {
  name: 'Nube Voladora',
  email: 'contacto@nubevoladora.montivero.ar',
  // número con código de país, sin + ni espacios
  whatsapp: '5491178148489',
  social: { instagram: '#', youtube: '#', tiktok: '#' },
};
export const WA_LINK = `https://wa.me/${SITE.whatsapp}?text=${encodeURIComponent('¡Hola! Quiero consultar por un proyecto de video.')}`;

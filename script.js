const canvas = document.getElementById('roulette-wheel');
const ctx = canvas.getContext('2d');
const spinButton = document.getElementById('spin-button');

const wheelSegments = [
  { number: '00', color: 'green' },
  { number: 27, color: 'red' },
  { number: 10, color: 'black' },
  { number: 25, color: 'red' },
  { number: 29, color: 'black' },
  { number: 12, color: 'red' },
  { number: 8, color: 'black' },
  { number: 19, color: 'red' },
  { number: 31, color: 'black' },
  { number: 18, color: 'red' },
  { number: 6, color: 'black' },
  { number: 21, color: 'red' },
  { number: 33, color: 'black' },
  { number: 16, color: 'red' },
  { number: 4, color: 'black' },
  { number: 23, color: 'red' },
  { number: 35, color: 'black' },
  { number: 14, color: 'red' },
  { number: 2, color: 'black' },
  { number: 0, color: 'green' },
  { number: 28, color: 'black' },
  { number: 9, color: 'red' },
  { number: 26, color: 'black' },
  { number: 30, color: 'red' },
  { number: 11, color: 'black' },
  { number: 7, color: 'red' },
  { number: 20, color: 'black' },
  { number: 32, color: 'red' },
  { number: 17, color: 'black' },
  { number: 5, color: 'red' },
  { number: 22, color: 'black' },
  { number: 34, color: 'red' },
  { number: 15, color: 'black' },
  { number: 3, color: 'red' },
  { number: 24, color: 'black' },
  { number: 36, color: 'red' },
  { number: 13, color: 'black' },
  { number: 1, color: 'red' }
];

const wheelRadius = canvas.width / 2;
const segmentAngle = (2 * Math.PI) / wheelSegments.length;
let currentAngle = 0;
let spinning = false;
let ballAngle = 0;
const ballRadius = 10;
let ballFluctuationAngle = 0; 
let fluctuationRange = { min: 162, max: 187 }; 

function drawWheel() {
  ctx.clearRect(0, 0, canvas.width, canvas.height); 
  const radius = wheelRadius;

  wheelSegments.forEach((segment, index) => {
    const startAngle = index * segmentAngle - currentAngle;
    const endAngle = startAngle + segmentAngle;

    ctx.beginPath();
    ctx.arc(radius, radius, radius, startAngle, endAngle);
    ctx.lineTo(radius, radius);
    ctx.fillStyle = segment.color;
    ctx.fill();
    ctx.lineWidth = 2; 
    ctx.strokeStyle = 'yellow'; 
    ctx.stroke();

   
    ctx.save();
    ctx.translate(radius, radius);
    ctx.rotate(startAngle + segmentAngle / 2);
    ctx.textAlign = "right";
    ctx.fillStyle = "#fff"; 
    ctx.font = "16px Arial";
    ctx.fillText(segment.number, radius - 20, 10); 
    ctx.restore();
  });

 
  ctx.beginPath();
  ctx.arc(radius, radius, 150, 0, 2 * Math.PI);
  ctx.fillStyle = 'green'; 
  ctx.fill();
  ctx.strokeStyle = 'yellow'; 
  ctx.lineWidth = 2; 
  ctx.stroke(); 


  ctx.beginPath();
  ctx.arc(radius, radius, 200, 0, 2 * Math.PI);
  ctx.lineWidth = 3; 
  ctx.strokeStyle = 'white'; 
  ctx.stroke(); 


  ctx.beginPath();
  ctx.arc(radius, radius, 55, 0, 2 * Math.PI);
  ctx.fillStyle = "black";
  ctx.fill();
  ctx.strokeStyle = "black";
  ctx.stroke();


  drawBall();
}

function drawBall() {
  ballFluctuationAngle += 0.02; 
  const ballRadiusFluctuation = fluctuationRange.min + (fluctuationRange.max - fluctuationRange.min) * (1 + Math.sin(ballFluctuationAngle)) / 2;
  const ballX = wheelRadius + ballRadiusFluctuation * Math.cos(ballAngle);
  const ballY = wheelRadius + ballRadiusFluctuation * Math.sin(ballAngle);

  ctx.beginPath();
  ctx.arc(ballX, ballY, ballRadius, 0, 2 * Math.PI);
  ctx.fillStyle = 'white';
  ctx.fill();
  ctx.strokeStyle = 'black';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function getRandomNumber(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}


function easeOutQuad(t) {
  return t * (2 - t);
}

function spinWheel() {
  if (spinning) return; 
  spinning = true;

  const startTime = Date.now();
  const spinDuration = 5000; 
  const rotationDegrees = getRandomNumber(1000, 5000); 
  const rotationRadians = rotationDegrees * (Math.PI / 180); 
  
  const startAngle = currentAngle; 
  const endAngle = (currentAngle + rotationRadians) % (2 * Math.PI);

  const ballStartAngle = ballAngle; 
  const ballEndAngle = (ballAngle + rotationRadians) % (2 * Math.PI);

  function animate() {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / spinDuration, 1); 
    const easedProgress = easeOutQuad(progress); 
    
    currentAngle = startAngle + (rotationRadians * easedProgress) % (2 * Math.PI);
    ballAngle = ballStartAngle + (rotationRadians * easedProgress) % (2 * Math.PI); 

    drawWheel(); 
    if (progress < 1) {
      requestAnimationFrame(animate); 
    } else {
      spinning = false;
      currentAngle = endAngle; 
      ballAngle = ballEndAngle; 
      calculateResult(); 
    }
  }


  animate();
}

function calculateResult() {

  const ballFinalAngle = ballAngle % (2 * Math.PI);

 
  let resultSegment = null;
  for (let i = 0; i < wheelSegments.length; i++) {
    const startAngle = (i * segmentAngle - currentAngle + 2 * Math.PI) % (2 * Math.PI);
    const endAngle = (startAngle + segmentAngle) % (2 * Math.PI);
    
    if (startAngle < endAngle) {
      if (ballFinalAngle >= startAngle && ballFinalAngle < endAngle) {
        resultSegment = wheelSegments[i];
        break;
      }
    } else {
      if (ballFinalAngle >= startAngle || ballFinalAngle < endAngle) {
        resultSegment = wheelSegments[i];
        break;
      }
    }
  }

  const resultText = `The ball landed on ${resultSegment.number} (${resultSegment.color})`;
  document.getElementById('results').innerHTML = `<p>${resultText}</p>`;

 
  console.log(`Ball Final Angle: ${ballFinalAngle}`);
  console.log(`Result Segment: ${resultSegment.number} (${resultSegment.color})`);
}


drawWheel();

spinButton.addEventListener('click', spinWheel);
